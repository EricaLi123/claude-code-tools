# Codex Completion Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Codex completion `notify` as the primary path, but let `codex-session-watch` emit exactly one delayed fallback `Stop` notification when legacy `notify` never reaches this package.

**Architecture:** Add a small temp-backed completion receipt store that the default notify path writes immediately after normalizing a valid Codex completion payload. Extend rollout parsing so watcher treats `event_msg.payload.type === "task_complete"` as a completion candidate, queues it behind a short grace window, does non-emitting preparation during that window, then performs one last receipt check immediately before emitting a fallback `Stop`.

**Tech Stack:** Node.js 16+, existing CommonJS modules in `bin/` and `lib/`, file-backed temp state under `%TEMP%\ai-agent-notify`, current `node test/test-cli.js` harness, existing PowerShell notification runtime.

---

## File Structure

- Create: `lib/codex-completion-receipts.js`
  - File-backed temp receipt store keyed by `sessionId|turnId|Stop`, with TTL pruning and a notify-facing helper.
- Create: `lib/codex-completion-pending.js`
  - Watcher-side pending queue, grace-window handling, early preparation, final receipt check, and flush logic for completion fallback.
- Create: `lib/codex-completion-notify.js`
  - Completion fallback preparation and emission that reuses the existing Windows notification runtime and sidecar terminal resolution.
- Modify: `bin/cli.js`
  - Write completion receipts before terminal probing / PowerShell spawn in default notify mode; update help text to mention completion fallback.
- Modify: `lib/codex-session-rollout-events.js`
  - Recognize rollout `task_complete` as a watcher completion candidate and assign a dedupe key aligned with the receipt key.
- Modify: `lib/codex-session-watch-handlers.js`
  - Route rollout completion candidates into the new pending completion queue while leaving approval and input handling intact.
- Modify: `lib/codex-session-watch-streams.js`
  - Thread `pendingCompletionNotifications` through session-file consumption.
- Modify: `lib/codex-session-watch-runner.js`
  - Allocate completion pending state and flush it every poll cycle using the real receipt and notification helpers.
- Modify: `README.md`
  - Document the new relationship: `notify` stays primary, watcher fallback is optional when sidecar is enabled.
- Modify: `docs/architecture.md`
  - Update the channel matrix and data-flow section to reflect notify-first completion with watcher-delayed fallback.
- Modify: `test/test-cli.js`
  - Register a new completion fallback suite.
- Create: `test/specs/completion-fallback.test.js`
  - Unit coverage for receipts, pending completion behavior, final receipt checks, handler wiring, and fallback emission.
- Modify: `test/specs/codex-events.test.js`
  - Cover rollout `task_complete` parsing.
- Modify: `test/specs/notification-and-docs.test.js`
  - Assert the updated README / architecture wording.
- Modify: `test/specs/structure-and-runtime.test.js`
  - Assert the new runtime files and spec file exist.

### Task 1: Completion Receipts And Early Notify Write

**Files:**
- Create: `lib/codex-completion-receipts.js`
- Modify: `bin/cli.js`
- Modify: `test/test-cli.js`
- Create: `test/specs/completion-fallback.test.js`
- Modify: `test/specs/structure-and-runtime.test.js`

- [ ] **Step 1: Write the failing receipt tests and register the suite**

```js
// test/test-cli.js
[
  require("./specs/structure-and-runtime.test"),
  require("./specs/sidecar.test"),
  require("./specs/approval-suppression.test"),
  require("./specs/codex-events.test"),
  require("./specs/completion-fallback.test"),
  require("./specs/notification-and-docs.test"),
  require("./specs/smoke.test"),
].forEach((runSuite) => runSuite(harness));
```

```js
// test/specs/completion-fallback.test.js
module.exports = function runCompletionFallbackTests(h) {
  const { assert, fs, path, ROOT, section, test } = h;
  const completionReceipts = require(path.join(ROOT, "lib", "codex-completion-receipts.js"));

  section("Completion fallback");

  test("codex completion receipt writer stores a Stop receipt keyed by session and turn", () => {
    const fixtureRoot = path.join(ROOT, `.tmp-completion-receipts-${Date.now()}`);

    try {
      const wrote = completionReceipts.writeCodexCompletionReceiptForNotification({
        notification: {
          agentId: "codex",
          eventName: "Stop",
          sessionId: "session-stop",
          turnId: "turn-stop",
        },
        runtime: { log: () => {} },
        receiptsDir: fixtureRoot,
        nowMs: Date.parse("2026-04-09T06:30:00.000Z"),
      });

      assert(wrote === true);
      assert(
        completionReceipts.hasCodexCompletionReceipt({
          sessionId: "session-stop",
          turnId: "turn-stop",
          receiptsDir: fixtureRoot,
          nowMs: Date.parse("2026-04-09T06:30:01.000Z"),
        }) === true
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("codex completion receipt writer ignores non-stop payloads and missing turn ids", () => {
    const fixtureRoot = path.join(ROOT, `.tmp-completion-receipts-ignore-${Date.now()}`);

    try {
      assert(
        completionReceipts.writeCodexCompletionReceiptForNotification({
          notification: {
            agentId: "codex",
            eventName: "PermissionRequest",
            sessionId: "session-ignore",
            turnId: "turn-ignore",
          },
          runtime: { log: () => {} },
          receiptsDir: fixtureRoot,
        }) === false
      );

      assert(
        completionReceipts.writeCodexCompletionReceiptForNotification({
          notification: {
            agentId: "codex",
            eventName: "Stop",
            sessionId: "session-ignore",
            turnId: "",
          },
          runtime: { log: () => {} },
          receiptsDir: fixtureRoot,
        }) === false
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
};
```

```js
// test/specs/structure-and-runtime.test.js
[
  "lib/codex-completion-receipts.js",
  "test/specs/completion-fallback.test.js",
].forEach((relPath) => {
  test(`${relPath} exists`, () => {
    assert(fs.existsSync(path.join(ROOT, relPath)), `${relPath} missing`);
  });
});
```

- [ ] **Step 2: Run the suite and verify the new coverage fails before implementation**

Run: `node test/test-cli.js`
Expected: FAIL with `Cannot find module '...lib/codex-completion-receipts.js'`

- [ ] **Step 3: Implement the receipt store and early notify write**

```js
// lib/codex-completion-receipts.js
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { LOG_DIR } = require("./notify-runtime");

const CODEX_COMPLETION_RECEIPT_TTL_MS = 10 * 60 * 1000;

function buildCodexCompletionReceiptKey({ sessionId, turnId, eventName = "Stop" }) {
  if (!sessionId || sessionId === "unknown" || !turnId || !eventName) {
    return "";
  }
  return [sessionId, turnId, eventName].join("|");
}

function getCodexCompletionReceiptDir(receiptsDir) {
  return receiptsDir || path.join(LOG_DIR, "completion-receipts");
}

function getCodexCompletionReceiptPath(key, receiptsDir) {
  const hash = crypto.createHash("sha1").update(key).digest("hex");
  return path.join(getCodexCompletionReceiptDir(receiptsDir), `${hash}.json`);
}

function writeCodexCompletionReceipt({
  runtime,
  sessionId,
  turnId,
  eventName = "Stop",
  receiptsDir,
  nowMs = Date.now(),
}) {
  const key = buildCodexCompletionReceiptKey({ sessionId, turnId, eventName });
  if (!key) {
    if (runtime && typeof runtime.log === "function") {
      runtime.log(
        `skipped completion receipt sessionId=${sessionId || "unknown"} turnId=${turnId || ""} eventName=${eventName}`
      );
    }
    return false;
  }

  try {
    pruneExpiredCodexCompletionReceipts({ receiptsDir, nowMs });
    const receiptPath = getCodexCompletionReceiptPath(key, receiptsDir);
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({
        key,
        sessionId,
        turnId,
        eventName,
        expiresAtMs: nowMs + CODEX_COMPLETION_RECEIPT_TTL_MS,
      }),
      "utf8"
    );
    if (runtime && typeof runtime.log === "function") {
      runtime.log(`wrote completion receipt sessionId=${sessionId} turnId=${turnId} eventName=${eventName}`);
    }
    return true;
  } catch (error) {
    if (runtime && typeof runtime.log === "function") {
      runtime.log(`failed to write completion receipt sessionId=${sessionId || "unknown"} turnId=${turnId || ""} error=${error.message}`);
    }
    return false;
  }
}

function hasCodexCompletionReceipt({
  sessionId,
  turnId,
  eventName = "Stop",
  receiptsDir,
  nowMs = Date.now(),
}) {
  const key = buildCodexCompletionReceiptKey({ sessionId, turnId, eventName });
  if (!key) {
    return false;
  }

  const receiptPath = getCodexCompletionReceiptPath(key, receiptsDir);
  if (!fs.existsSync(receiptPath)) {
    return false;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (!payload.expiresAtMs || payload.expiresAtMs <= nowMs) {
      fs.rmSync(receiptPath, { force: true });
      return false;
    }
    return true;
  } catch {
    fs.rmSync(receiptPath, { force: true });
    return false;
  }
}

function pruneExpiredCodexCompletionReceipts({ receiptsDir, nowMs = Date.now() }) {
  const dir = getCodexCompletionReceiptDir(receiptsDir);
  if (!fs.existsSync(dir)) {
    return 0;
  }

  let removed = 0;
  fs.readdirSync(dir).forEach((entry) => {
    const receiptPath = path.join(dir, entry);
    try {
      const payload = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      if (!payload.expiresAtMs || payload.expiresAtMs <= nowMs) {
        fs.rmSync(receiptPath, { force: true });
        removed += 1;
      }
    } catch {
      fs.rmSync(receiptPath, { force: true });
      removed += 1;
    }
  });
  return removed;
}

function writeCodexCompletionReceiptForNotification({
  notification,
  runtime,
  receiptsDir,
  nowMs = Date.now(),
}) {
  if (
    !notification ||
    notification.agentId !== "codex" ||
    notification.eventName !== "Stop"
  ) {
    return false;
  }

  return writeCodexCompletionReceipt({
    runtime,
    sessionId: notification.sessionId,
    turnId: notification.turnId,
    eventName: notification.eventName,
    receiptsDir,
    nowMs,
  });
}

module.exports = {
  CODEX_COMPLETION_RECEIPT_TTL_MS,
  buildCodexCompletionReceiptKey,
  hasCodexCompletionReceipt,
  pruneExpiredCodexCompletionReceipts,
  writeCodexCompletionReceipt,
  writeCodexCompletionReceiptForNotification,
};
```

```js
// bin/cli.js
const {
  writeCodexCompletionReceiptForNotification,
} = require("../lib/codex-completion-receipts");

async function runDefaultNotifyMode(argv) {
  const stdinData = readStdin();
  const notification = normalizeIncomingNotification({
    argv,
    stdinData,
    env: process.env,
  });
  const sessionId = notification.sessionId || "unknown";
  const runtime = createRuntime(sessionId);

  writeCodexCompletionReceiptForNotification({
    notification,
    runtime,
  });

  const terminal = detectTerminalContext(argv, runtime.log);

  runtime.log(
    `started mode=notify agent=${notification.agentId} transport=${notification.transport || "none"} session=${sessionId} packageRoot=${runtime.buildInfo.packageRoot}`
  );
  runtime.log(notification.debugSummary);

  const child = emitNotification({
    agentId: notification.agentId,
    eventName: notification.eventName,
    title: notification.title,
    message: notification.message,
    rawEventType: notification.rawEventType,
    runtime,
    terminal,
  });
```

- [ ] **Step 4: Re-run the suite and verify the receipt coverage passes**

Run: `node test/test-cli.js`
Expected: PASS for the two new `Completion fallback` receipt tests and overall `0 failed`

- [ ] **Step 5: Commit the receipt work**

```bash
git add bin/cli.js lib/codex-completion-receipts.js test/test-cli.js test/specs/completion-fallback.test.js test/specs/structure-and-runtime.test.js
git commit -m "feat: add codex completion receipts"
```

### Task 2: Rollout Completion Candidates And Pending Fallback State

**Files:**
- Create: `lib/codex-completion-pending.js`
- Modify: `lib/codex-session-rollout-events.js`
- Modify: `test/specs/codex-events.test.js`
- Modify: `test/specs/completion-fallback.test.js`
- Modify: `test/specs/structure-and-runtime.test.js`

- [ ] **Step 1: Write the failing rollout and pending-state tests**

```js
// test/specs/codex-events.test.js
test("session watcher recognizes rollout task_complete as a Stop candidate", () => {
  const event = events.buildCodexSessionEvent(
    {
      filePath:
        "C:\\Users\\ericali\\.codex\\sessions\\2026\\04\\09\\rollout-2026-04-09T06-14-17-session-stop.jsonl",
      sessionId: "session-stop",
      cwd: TEST_PACKAGE_DIR,
      turnId: "turn-stop",
    },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-stop",
        cwd: TEST_PACKAGE_DIR,
      },
    }
  );

  assert(event);
  assert(event.eventName === "Stop");
  assert(event.eventType === "task_complete");
  assert(event.dedupeKey === "session-stop|turn-stop|Stop");
});
```

```js
// test/specs/completion-fallback.test.js
const completionPending = require(path.join(ROOT, "lib", "codex-completion-pending.js"));

test("pending completion fallback prepares early but rechecks receipts immediately before emit", () => {
  const pendingCompletionNotifications = new Map();
  const calls = [];

  completionPending.queuePendingCompletionNotification({
    runtime: { log: () => {} },
    pendingCompletionNotifications,
    event: {
      source: "Codex",
      eventName: "Stop",
      eventType: "task_complete",
      sessionId: "session-stop",
      turnId: "turn-stop",
      dedupeKey: "session-stop|turn-stop|Stop",
      title: "Done",
      message: "Task finished",
      projectDir: "D:\\repo\\sample-project",
    },
    nowMs: 1000,
  });

  completionPending.flushPendingCompletionNotifications({
    runtime: { log: () => {} },
    pendingCompletionNotifications,
    emittedEventKeys: new Map(),
    nowMs: 1001,
    preparePendingCompletionNotification: ({ pending }) => {
      calls.push(`prepare:${pending.turnId}`);
      return { event: pending, notificationTerminal: { hwnd: null, shellPid: null, isWindowsTerminal: false } };
    },
    hasCompletionReceipt: () => false,
    emitPreparedCompletionNotification: () => {
      calls.push("emit-too-early");
    },
  });

  completionPending.flushPendingCompletionNotifications({
    runtime: { log: () => {} },
    pendingCompletionNotifications,
    emittedEventKeys: new Map(),
    nowMs: 2501,
    preparePendingCompletionNotification: ({ pending }) => {
      calls.push(`prepare-again:${pending.turnId}`);
      return { event: pending, notificationTerminal: { hwnd: null, shellPid: null, isWindowsTerminal: false } };
    },
    hasCompletionReceipt: ({ sessionId, turnId, eventName }) => {
      calls.push(`receipt:${sessionId}:${turnId}:${eventName}`);
      return false;
    },
    emitPreparedCompletionNotification: ({ prepared }) => {
      calls.push(`emit:${prepared.event.turnId}`);
    },
  });

  assert(calls.join("|") === "prepare:turn-stop|receipt:session-stop:turn-stop:Stop|emit:turn-stop");
});

test("pending completion fallback drops the candidate when a matching receipt exists", () => {
  const pendingCompletionNotifications = new Map();
  const calls = [];

  completionPending.queuePendingCompletionNotification({
    runtime: { log: () => {} },
    pendingCompletionNotifications,
    event: {
      source: "Codex",
      eventName: "Stop",
      eventType: "task_complete",
      sessionId: "session-receipt",
      turnId: "turn-receipt",
      dedupeKey: "session-receipt|turn-receipt|Stop",
      title: "Done",
      message: "Task finished",
      projectDir: "D:\\repo\\sample-project",
    },
    nowMs: 500,
  });

  completionPending.flushPendingCompletionNotifications({
    runtime: { log: () => {} },
    pendingCompletionNotifications,
    emittedEventKeys: new Map(),
    nowMs: 2001,
    preparePendingCompletionNotification: ({ pending }) => {
      calls.push(`prepare:${pending.turnId}`);
      return { event: pending, notificationTerminal: { hwnd: null, shellPid: null, isWindowsTerminal: false } };
    },
    hasCompletionReceipt: () => true,
    emitPreparedCompletionNotification: () => {
      calls.push("emit");
    },
  });

  assert(calls.join("|") === "prepare:turn-receipt");
  assert(pendingCompletionNotifications.size === 0);
});
```

```js
// test/specs/structure-and-runtime.test.js
[
  "lib/codex-completion-pending.js",
].forEach((relPath) => {
  test(`${relPath} exists`, () => {
    assert(fs.existsSync(path.join(ROOT, relPath)), `${relPath} missing`);
  });
});
```

- [ ] **Step 2: Run the suite and verify the new completion candidate coverage fails**

Run: `node test/test-cli.js`
Expected: FAIL because rollout `task_complete` is not recognized yet and `lib/codex-completion-pending.js` does not exist

- [ ] **Step 3: Implement rollout completion parsing and pending fallback state**

```js
// lib/codex-completion-pending.js
const { buildCodexCompletionReceiptKey } = require("./codex-completion-receipts");

const CODEX_COMPLETION_FALLBACK_GRACE_MS = 1500;

function buildPendingCompletionKey(event) {
  return (
    (event && event.dedupeKey) ||
    buildCodexCompletionReceiptKey({
      sessionId: event && event.sessionId,
      turnId: event && event.turnId,
      eventName: "Stop",
    })
  );
}

function queuePendingCompletionNotification({
  runtime,
  pendingCompletionNotifications,
  event,
  nowMs = Date.now(),
}) {
  const key = buildPendingCompletionKey(event);
  if (!key || pendingCompletionNotifications.has(key)) {
    return key;
  }

  pendingCompletionNotifications.set(key, {
    ...event,
    pendingSinceMs: nowMs,
    deadlineMs: nowMs + CODEX_COMPLETION_FALLBACK_GRACE_MS,
    graceMs: CODEX_COMPLETION_FALLBACK_GRACE_MS,
    prepared: null,
  });

  runtime.log(
    `queued completion fallback sessionId=${event.sessionId || "unknown"} turnId=${event.turnId || ""} graceMs=${CODEX_COMPLETION_FALLBACK_GRACE_MS}`
  );
  return key;
}

function flushPendingCompletionNotifications({
  runtime,
  pendingCompletionNotifications,
  emittedEventKeys,
  nowMs = Date.now(),
  preparePendingCompletionNotification,
  hasCompletionReceipt,
  emitPreparedCompletionNotification,
}) {
  Array.from(pendingCompletionNotifications.entries()).forEach(([key, pending]) => {
    if (!pending.prepared && typeof preparePendingCompletionNotification === "function") {
      pending.prepared = preparePendingCompletionNotification({ pending });
      runtime.log(
        `prepared completion fallback sessionId=${pending.sessionId || "unknown"} turnId=${pending.turnId || ""}`
      );
    }

    if (pending.deadlineMs > nowMs) {
      return;
    }

    const hasReceipt =
      typeof hasCompletionReceipt === "function" &&
      hasCompletionReceipt({
        sessionId: pending.sessionId,
        turnId: pending.turnId,
        eventName: "Stop",
        nowMs,
      });

    if (hasReceipt) {
      pendingCompletionNotifications.delete(key);
      runtime.log(
        `dropped completion fallback sessionId=${pending.sessionId || "unknown"} turnId=${pending.turnId || ""} reason=receipt_found`
      );
      return;
    }

    if (typeof emitPreparedCompletionNotification === "function") {
      emitPreparedCompletionNotification({
        prepared: pending.prepared || { event: pending },
        emittedEventKeys,
        origin: "pending",
      });
    }

    pendingCompletionNotifications.delete(key);
  });
}

module.exports = {
  CODEX_COMPLETION_FALLBACK_GRACE_MS,
  buildPendingCompletionKey,
  flushPendingCompletionNotifications,
  queuePendingCompletionNotification,
};
```

```js
// lib/codex-session-rollout-events.js
const { buildCodexCompletionReceiptKey } = require("./codex-completion-receipts");

function buildCodexSessionEvent(state, record) {
  const payload = record && record.payload;
  if (!payload || typeof payload.type !== "string") {
    return null;
  }

  const sessionId = state.sessionId || parseSessionIdFromRolloutPath(state.filePath) || "unknown";
  const projectDir = payload.cwd || state.cwd || "";
  const turnId = payload.turn_id || state.turnId || "";
  const callId = payload.call_id || "";
  const approvalId = payload.approval_id || "";

  if (record.type === "response_item" && payload.type === "function_call") {
    return buildSessionFunctionCallEvent({
      callId,
      payload,
      projectDir,
      sessionId,
      turnId,
    });
  }

  if (record.type !== "event_msg") {
    return null;
  }

  switch (payload.type) {
    case "task_complete":
      return createSessionCompletionEvent({
        payload,
        projectDir,
        sessionId,
        turnId,
      });
    case "exec_approval_request":
    case "request_permissions":
      return createSessionApprovalRequestEvent({
        approvalId,
        approvalKind: "exec",
        callId,
        payload,
        projectDir,
        sessionId,
        turnId,
      });
```

```js
// lib/codex-session-rollout-events.js
function createSessionCompletionEvent({ payload, projectDir, sessionId, turnId }) {
  if (!turnId) {
    return null;
  }

  return {
    ...createNotificationSpec({
      agentId: "codex",
      sessionId,
      turnId,
      eventName: "Stop",
      projectDir,
      rawEventType: payload.type,
    }),
    eventType: payload.type,
    dedupeKey: buildCodexCompletionReceiptKey({
      sessionId,
      turnId,
      eventName: "Stop",
    }),
  };
}
```

- [ ] **Step 4: Re-run the suite and verify rollout parsing and pending-state tests pass**

Run: `node test/test-cli.js`
Expected: PASS for the new `task_complete` event test and the two pending completion tests

- [ ] **Step 5: Commit the rollout candidate work**

```bash
git add lib/codex-completion-pending.js lib/codex-session-rollout-events.js test/specs/codex-events.test.js test/specs/completion-fallback.test.js test/specs/structure-and-runtime.test.js
git commit -m "feat: add rollout completion fallback state"
```

### Task 3: Watcher Wiring And Real Fallback Emission

**Files:**
- Create: `lib/codex-completion-notify.js`
- Modify: `lib/codex-session-watch-handlers.js`
- Modify: `lib/codex-session-watch-streams.js`
- Modify: `lib/codex-session-watch-runner.js`
- Modify: `test/specs/completion-fallback.test.js`
- Modify: `test/specs/structure-and-runtime.test.js`

- [ ] **Step 1: Write the failing watcher integration tests**

```js
// test/specs/completion-fallback.test.js
const watchHandlers = require(path.join(ROOT, "lib", "codex-session-watch-handlers.js"));
const completionNotify = require(path.join(ROOT, "lib", "codex-completion-notify.js"));

test("session handler queues rollout task_complete into pending completion state", () => {
  const pendingCompletionNotifications = new Map();

  watchHandlers.handleSessionRecord(
    {
      filePath:
        "C:\\Users\\ericali\\.codex\\sessions\\2026\\04\\09\\rollout-2026-04-09T06-14-17-session-stop.jsonl",
      sessionId: "session-stop",
      cwd: TEST_PACKAGE_DIR,
      turnId: "turn-stop",
    },
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-stop",
        cwd: TEST_PACKAGE_DIR,
      },
    }),
    {
      runtime: { log: () => {} },
      sessionsDir: ROOT,
      terminal: { hwnd: null, shellPid: null, isWindowsTerminal: false },
      emittedEventKeys: new Map(),
      pendingApprovalNotifications: new Map(),
      pendingApprovalCallIds: new Map(),
      recentRequireEscalatedEvents: new Map(),
      sessionApprovalGrants: new Map(),
      approvedCommandRuleCache: { filePath: "", mtimeMs: -1, size: -1, rules: [] },
      pendingCompletionNotifications,
    }
  );

  assert(pendingCompletionNotifications.size === 1);
});

test("prepared completion fallback reuses the normal notification runtime and emits Stop once", () => {
  const emitted = [];
  const fakeChild = { on: () => {} };

  const didEmit = completionNotify.emitPreparedCodexCompletionNotification({
    prepared: {
      event: {
        source: "Codex",
        eventName: "Stop",
        title: "Done",
        message: "Task finished",
        eventType: "task_complete",
        sessionId: "session-stop",
        turnId: "turn-stop",
        projectDir: TEST_PACKAGE_DIR,
        dedupeKey: "session-stop|turn-stop|Stop",
      },
      notificationTerminal: { hwnd: null, shellPid: null, isWindowsTerminal: false },
    },
    runtime: { log: () => {} },
    emittedEventKeys: new Map(),
    origin: "pending",
    emitNotificationImpl: (payload) => {
      emitted.push(payload);
      return fakeChild;
    },
  });

  assert(didEmit === true);
  assert(emitted.length === 1);
  assert(emitted[0].eventName === "Stop");
});
```

```js
// test/specs/structure-and-runtime.test.js
[
  "lib/codex-completion-notify.js",
].forEach((relPath) => {
  test(`${relPath} exists`, () => {
    assert(fs.existsSync(path.join(ROOT, relPath)), `${relPath} missing`);
  });
});
```

- [ ] **Step 2: Run the suite and verify watcher integration fails before wiring**

Run: `node test/test-cli.js`
Expected: FAIL because `pendingCompletionNotifications` is not threaded through the watcher and `lib/codex-completion-notify.js` does not exist

- [ ] **Step 3: Implement real watcher preparation, final receipt check, and fallback emission**

```js
// lib/codex-completion-notify.js
const { resolveApprovalTerminalContext, shouldEmitEventKey } = require("./codex-approval-notify");
const { emitNotification } = require("./notify-runtime");

function prepareCodexCompletionNotification({
  event,
  runtime,
  terminal,
  sessionsDir,
  resolveTerminalContext = resolveApprovalTerminalContext,
}) {
  const notificationTerminal = resolveTerminalContext({
    sessionId: event.sessionId,
    projectDir: event.projectDir,
    fallbackTerminal: terminal,
    log: runtime.log,
    sessionsDir,
  });

  return {
    event,
    notificationTerminal,
  };
}

function emitPreparedCodexCompletionNotification({
  prepared,
  runtime,
  emittedEventKeys,
  origin,
  emitNotificationImpl = emitNotification,
}) {
  const event = prepared.event;
  if (!shouldEmitEventKey(emittedEventKeys, event.dedupeKey)) {
    return false;
  }

  runtime.log(
    `${origin} completion fallback matched sessionId=${event.sessionId || "unknown"} turnId=${event.turnId || ""} cwd=${event.projectDir || ""}`
  );

  const child = emitNotificationImpl({
    agentId: event.agentId,
    eventName: event.eventName,
    title: event.title,
    message: event.message,
    rawEventType: event.eventType,
    runtime,
    terminal: prepared.notificationTerminal,
  });

  child.on("close", (code) => {
    runtime.log(
      `notify.ps1 exited code=${code} sessionId=${event.sessionId || "unknown"} eventType=${event.eventType}`
    );
  });

  child.on("error", (error) => {
    runtime.log(
      `notify.ps1 spawn failed sessionId=${event.sessionId || "unknown"} eventType=${event.eventType} error=${error.message}`
    );
  });

  return true;
}

module.exports = {
  emitPreparedCodexCompletionNotification,
  prepareCodexCompletionNotification,
};
```

```js
// lib/codex-session-watch-handlers.js
const {
  queuePendingCompletionNotification,
} = require("./codex-completion-pending");

function handleSessionRecord(
  state,
  line,
  {
    runtime,
    sessionsDir,
    terminal,
    emittedEventKeys,
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    recentRequireEscalatedEvents,
    sessionApprovalGrants,
    approvedCommandRuleCache,
    pendingCompletionNotifications,
  }
) {
  const event = buildCodexSessionEvent(state, record);
  if (!event) {
    return;
  }

  if (event.eventName === "Stop") {
    queuePendingCompletionNotification({
      runtime,
      pendingCompletionNotifications,
      event,
    });
    return;
  }

  if (event.eventType !== "require_escalated_tool_call") {
    emitCodexApprovalNotification({
      event,
      runtime,
      terminal,
      emittedEventKeys,
      origin: "session",
      sessionsDir,
    });
    return;
  }
```

```js
// lib/codex-session-watch-streams.js
function consumeSessionFileUpdates(
  state,
  stat,
  {
    runtime,
    sessionsDir,
    terminal,
    emittedEventKeys,
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    recentRequireEscalatedEvents,
    sessionApprovalGrants,
    approvedCommandRuleCache,
    pendingCompletionNotifications,
  }
) {
  consumeTailFileLines({
    state,
    stat,
    runtime,
    truncationLabel: "session file",
    onLine: (line) => {
      if (!line.trim()) {
        return;
      }
      handleSessionRecord(state, line, {
        runtime,
        sessionsDir,
        terminal,
        emittedEventKeys,
        pendingApprovalNotifications,
        pendingApprovalCallIds,
        recentRequireEscalatedEvents,
        sessionApprovalGrants,
        approvedCommandRuleCache,
        pendingCompletionNotifications,
      });
    },
  });
}
```

```js
// lib/codex-session-watch-runner.js
const {
  emitPreparedCodexCompletionNotification,
  prepareCodexCompletionNotification,
} = require("./codex-completion-notify");
const {
  flushPendingCompletionNotifications,
} = require("./codex-completion-pending");
const { hasCodexCompletionReceipt } = require("./codex-completion-receipts");

const pendingCompletionNotifications = new Map();

consumeSessionFileUpdates(state, stat, {
  runtime,
  sessionsDir,
  terminal,
  emittedEventKeys,
  pendingApprovalNotifications,
  pendingApprovalCallIds,
  recentRequireEscalatedEvents,
  sessionApprovalGrants,
  approvedCommandRuleCache,
  pendingCompletionNotifications,
});

flushPendingApprovalNotifications({
  runtime,
  sessionsDir,
  terminal,
  emittedEventKeys,
  pendingApprovalNotifications,
  pendingApprovalCallIds,
});

flushPendingCompletionNotifications({
  runtime,
  pendingCompletionNotifications,
  emittedEventKeys,
  preparePendingCompletionNotification: ({ pending }) =>
    prepareCodexCompletionNotification({
      event: pending,
      runtime,
      terminal,
      sessionsDir,
    }),
  hasCompletionReceipt: (args) => hasCodexCompletionReceipt(args),
  emitPreparedCompletionNotification: ({ prepared, origin }) =>
    emitPreparedCodexCompletionNotification({
      prepared,
      runtime,
      emittedEventKeys,
      origin,
    }),
});

pruneEmittedEventKeys(emittedEventKeys, 4096);
```

- [ ] **Step 4: Re-run the suite and verify watcher integration passes without approval regressions**

Run: `node test/test-cli.js`
Expected: PASS for the two new watcher integration tests and existing approval / input suites remain green

- [ ] **Step 5: Commit the watcher wiring**

```bash
git add lib/codex-completion-notify.js lib/codex-session-watch-handlers.js lib/codex-session-watch-streams.js lib/codex-session-watch-runner.js test/specs/completion-fallback.test.js test/specs/structure-and-runtime.test.js
git commit -m "feat: wire watcher completion fallback"
```

### Task 4: Public Docs And Regression Assertions

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `bin/cli.js`
- Modify: `test/specs/notification-and-docs.test.js`

- [ ] **Step 1: Write the failing docs assertions for notify-first completion fallback**

```js
// test/specs/notification-and-docs.test.js
test("README documents watcher completion fallback without replacing notify-first completion", () => {
  const readmeContent = read("README.md");
  assert(readmeContent.includes("primary completion path"));
  assert(readmeContent.includes("watcher-side completion fallback"));
  assert(readmeContent.includes("approval reminders"));
});

test("architecture documents task_complete receipts and delayed fallback", () => {
  const architectureContent = read("docs/architecture.md");
  assert(architectureContent.includes("task_complete"));
  assert(architectureContent.includes("completion receipt"));
  assert(architectureContent.includes("notify-first"));
});
```

- [ ] **Step 2: Run the suite and verify the docs assertions fail before the wording update**

Run: `node test/test-cli.js`
Expected: FAIL because README and `docs/architecture.md` do not mention notify-first completion fallback yet

- [ ] **Step 3: Update README, architecture, and help text**

```md
<!-- README.md -->
- `notify = [...]` remains the primary completion path.
- Add the `ai_agent_notify_sidecar` block if you also want approval reminders and watcher-side completion fallback when legacy `notify` does not arrive.
- If you only care about basic completion notifications, you can omit the sidecar block; `notify` still works on its own.

- `codex-session-watch` is the main path for approval reminders and delayed completion fallback.
- `codex-mcp-sidecar` will usually auto-start `codex-session-watch`.

- **Very long Codex sessions:** Windows can stop firing legacy completion `notify` after a very long session; `clear` or start a new session if this happens, and enable the sidecar/watch path if you want fallback coverage
```

```md
<!-- docs/architecture.md -->
- completion remains `notify`-first; `codex-session-watch` only provides delayed fallback when a matching completion receipt is missing.

| Codex legacy `notify` | 一次性 completion payload、常见场景下的 `thread-id` / `turn-id` / `cwd`，以及触发当场可直接探测到的终端上下文 | approval 请求 | 正常 completion 通知 + completion receipt |
| `codex-session-watch` | rollout `sessionId`、`task_complete`、approval event、`cwd`、TUI 里的早期 approval 线索 | 启动当场的终端句柄、原始 tab 句柄 | approval 检测 + delayed completion fallback |

Completion:
  Codex turn complete
    ├─ rollout 记录 `task_complete`
    ├─ 若 legacy `notify` 到达，ai-agent-notify 先写 completion receipt，再继续正常通知
    ├─ watcher 把同一 turn 的 completion 候选放进短暂 grace 窗口
    └─ watcher 在真正 `emitNotification()` 前最后再查一次 receipt；只有 receipt 仍不存在时才补发 fallback `Stop`
```

```js
// bin/cli.js
"  codex-session-watch Watch local Codex rollout files and TUI logs for approval events and completion fallback",
```

- [ ] **Step 4: Run the full regression suite and formatting check**

Run: `node test/test-cli.js`
Expected: PASS with `0 failed`

Run: `git diff --check`
Expected: no output

- [ ] **Step 5: Commit the docs update**

```bash
git add README.md docs/architecture.md bin/cli.js test/specs/notification-and-docs.test.js
git commit -m "docs: describe codex completion fallback"
```
