const crypto = require("crypto");

module.exports = function runCompletionFallbackTests(h) {
  const {
    assert,
    fs,
    normalizeIncomingNotification,
    notifyRuntime,
    path,
    ROOT,
    section,
    test,
    TEST_PACKAGE_DIR,
  } = h;
  const completionReceipts = require(path.join(
    ROOT,
    "lib",
    "codex-completion-receipts.js"
  ));
  const receiptsDir = path.join(notifyRuntime.LOG_DIR, "completion-receipts");

  function getReceiptPathForKey(key) {
    const fileName = `${crypto.createHash("sha1").update(key).digest("hex")}.json`;
    return path.join(receiptsDir, fileName);
  }

  function deleteReceiptByKey(key) {
    if (!key) {
      return;
    }

    const receiptPath = getReceiptPathForKey(key);
    if (!fs.existsSync(receiptPath)) {
      return;
    }

    try {
      fs.unlinkSync(receiptPath);
    } catch {}
  }

  section("Completion fallback");

  function loadCompletionPending() {
    return require(path.join(ROOT, "lib", "codex-completion-pending.js"));
  }

  function loadSessionWatchHandlers() {
    return require(path.join(ROOT, "lib", "codex-session-watch-handlers.js"));
  }

  function loadCompletionNotify() {
    return require(path.join(ROOT, "lib", "codex-completion-notify.js"));
  }

  test("writeCodexCompletionReceiptForNotification writes a Stop receipt keyed by session + turn", () => {
    const sessionId = `completion-session-${process.pid}-${Date.now()}`;
    const turnId = `turn-${process.hrtime.bigint().toString()}`;
    const key = completionReceipts.buildCodexCompletionReceiptKey({
      sessionId,
      turnId,
      eventName: "Stop",
    });
    const receiptPath = getReceiptPathForKey(key);

    deleteReceiptByKey(key);

    try {
      completionReceipts.writeCodexCompletionReceiptForNotification({
        sourceId: "codex-legacy-notify",
        eventName: "Stop",
        sessionId,
        turnId,
      });

      assert(fs.existsSync(receiptPath), "expected Stop completion receipt file to exist");
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));

      assert(receipt.key === key, "receipt key mismatch");
      assert(receipt.sessionId === sessionId, "receipt sessionId mismatch");
      assert(receipt.turnId === turnId, "receipt turnId mismatch");
      assert(receipt.eventName === "Stop", "receipt eventName mismatch");
      assert(
        typeof receipt.expiresAtMs === "number" && receipt.expiresAtMs > Date.now(),
        "receipt expiresAtMs should be in the future"
      );
      assert(
        completionReceipts.hasCodexCompletionReceipt({
          sessionId,
          turnId,
          eventName: "Stop",
        }),
        "expected Stop receipt lookup to succeed"
      );
    } finally {
      deleteReceiptByKey(key);
    }
  });

  test("writeCodexCompletionReceiptForNotification ignores non-Stop payloads and missing turn ids", () => {
    const nonStopSessionId = `completion-nonstop-${process.pid}-${Date.now()}`;
    const nonStopTurnId = `turn-${process.hrtime.bigint().toString()}`;
    const nonStopKey = completionReceipts.buildCodexCompletionReceiptKey({
      sessionId: nonStopSessionId,
      turnId: nonStopTurnId,
      eventName: "Stop",
    });
    const nonStopReceiptPath = getReceiptPathForKey(nonStopKey);

    deleteReceiptByKey(nonStopKey);

    try {
      const nonStopResult = completionReceipts.writeCodexCompletionReceiptForNotification({
        sourceId: "codex-legacy-notify",
        eventName: "PermissionRequest",
        sessionId: nonStopSessionId,
        turnId: nonStopTurnId,
      });
      const missingTurnResult =
        completionReceipts.writeCodexCompletionReceiptForNotification({
          sourceId: "codex-legacy-notify",
          eventName: "Stop",
          sessionId: `completion-missing-turn-${process.pid}-${Date.now()}`,
          turnId: "",
        });

      assert(!nonStopResult, "non-Stop payload should not write a receipt");
      assert(!missingTurnResult, "missing turn id should not write a receipt");
      assert(
        completionReceipts.buildCodexCompletionReceiptKey({
          sessionId: "completion-missing-turn",
          turnId: "",
          eventName: "Stop",
        }) === "",
        "missing turn ids should produce an empty receipt key"
      );
      assert(
        !fs.existsSync(nonStopReceiptPath),
        "non-Stop payload should not create a completion receipt file"
      );
      assert(
        !completionReceipts.hasCodexCompletionReceipt({
          sessionId: nonStopSessionId,
          turnId: nonStopTurnId,
          eventName: "Stop",
        }),
        "non-Stop payload should not create a readable receipt"
      );
    } finally {
      deleteReceiptByKey(nonStopKey);
    }
  });

  test("turn-only legacy Codex Stop payload does not create a synthetic completion receipt", () => {
    const turnId = `turn-only-${process.pid}-${Date.now()}`;
    const syntheticKey = completionReceipts.buildCodexCompletionReceiptKey({
      sessionId: turnId,
      turnId,
      eventName: "Stop",
    });
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      client: "codex-cli",
      "turn-id": turnId,
    });
    const notification = normalizeIncomingNotification({
      argv: [payload],
      stdinData: "",
      env: {},
    });

    deleteReceiptByKey(syntheticKey);

    try {
      const wrote = completionReceipts.writeCodexCompletionReceiptForNotification(notification);

      assert(notification.sourceId === "codex-legacy-notify", "expected codex legacy notification");
      assert(notification.turnId === turnId, "expected turn id");
      assert(notification.sessionId === "unknown", "turn-only payload should not synthesize sessionId");
      assert(!wrote, "turn-only payload should not write a completion receipt");
      assert(
        !completionReceipts.hasCodexCompletionReceipt({
          sessionId: turnId,
          turnId,
          eventName: "Stop",
        }),
        "turn-only payload should not produce a synthetic receipt"
      );
    } finally {
      deleteReceiptByKey(syntheticKey);
    }
  });

  test("cli writes completion receipt before terminal detection runs", () => {
    const cli = require(path.join(ROOT, "bin", "cli.js"));
    const sessionId = `cli-order-session-${process.pid}-${Date.now()}`;
    const turnId = `cli-order-turn-${process.hrtime.bigint().toString()}`;
    const key = completionReceipts.buildCodexCompletionReceiptKey({
      sessionId,
      turnId,
      eventName: "Stop",
    });
    let receiptSeenDuringDetect = false;

    deleteReceiptByKey(key);

    try {
      cli.runDefaultNotifyMode([], {
        stdinData: "",
        normalizeIncomingNotificationImpl: () => ({
          sourceId: "codex-legacy-notify",
          source: "Codex",
          transport: "argv[0]",
          sessionId,
          turnId,
          eventName: "Stop",
          title: "Done",
          message: "Task finished",
          rawEventType: "agent-turn-complete",
          debugSummary: "test payload",
        }),
        createRuntimeImpl: () => ({
          buildInfo: { packageRoot: ROOT },
          isDev: true,
          logFile: path.join(notifyRuntime.LOG_DIR, `test-log-${Date.now()}.log`),
          logStem: `test-log-${Date.now()}`,
          log: () => {},
        }),
        detectTerminalContextImpl: () => {
          receiptSeenDuringDetect = completionReceipts.hasCodexCompletionReceipt({
            sessionId,
            turnId,
            eventName: "Stop",
          });
          return {
            hwnd: null,
            shellPid: null,
            isWindowsTerminal: false,
          };
        },
        emitNotificationImpl: () => ({
          on: () => {},
        }),
        exitProcessImpl: () => {},
      });

      assert(receiptSeenDuringDetect, "receipt should exist before terminal detection");
    } finally {
      deleteReceiptByKey(key);
    }
  });

  test("pending completion fallback prepares during grace and only checks receipts + emits after deadline", () => {
    const completionPending = loadCompletionPending();
    const pendingCompletionNotifications = new Map();
    const emittedEventKeys = new Map();
    const logs = [];
    const runtime = {
      log: (line) => logs.push(line),
    };
    const event = {
      sourceId: "codex-session-watch",
      sessionId: "pending-session",
      turnId: "pending-turn",
      eventName: "Stop",
      eventType: "task_complete",
      dedupeKey: "pending-session|pending-turn|Stop",
    };
    const prepareCalls = [];
    const receiptCalls = [];
    const emitCalls = [];

    completionPending.queuePendingCompletionNotification({
      runtime,
      pendingCompletionNotifications,
      emittedEventKeys,
      event,
      nowMs: 1_000,
    });

    assert(pendingCompletionNotifications.size === 1, "expected one pending completion");
    const pending = pendingCompletionNotifications.get(event.dedupeKey);
    assert(pending, "missing queued pending completion");
    assert(pending.pendingSinceMs === 1_000, "pendingSinceMs mismatch");
    assert(
      pending.deadlineMs === 1_000 + completionPending.CODEX_COMPLETION_FALLBACK_GRACE_MS,
      "deadlineMs mismatch"
    );
    assert(
      pending.graceMs === completionPending.CODEX_COMPLETION_FALLBACK_GRACE_MS,
      "graceMs mismatch"
    );
    assert(pending.prepared === null, "prepared should initialize to null");

    completionPending.flushPendingCompletionNotifications({
      runtime,
      pendingCompletionNotifications,
      emittedEventKeys,
      nowMs: pending.deadlineMs - 1,
      preparePendingCompletionNotification: ({ pending: pendingEvent }) => {
        prepareCalls.push(pendingEvent.dedupeKey);
        return { event: pendingEvent, title: "Prepared completion" };
      },
      hasCompletionReceipt: (input) => {
        receiptCalls.push(input);
        return false;
      },
      emitPreparedCompletionNotification: (input) => {
        emitCalls.push(input);
      },
    });

    assert(prepareCalls.length === 1, "prepare should run during grace window");
    assert(receiptCalls.length === 0, "receipt check should wait until deadline");
    assert(emitCalls.length === 0, "emit should wait until deadline");
    assert(
      pendingCompletionNotifications.has(event.dedupeKey),
      "pending completion should remain queued during grace"
    );

    completionPending.flushPendingCompletionNotifications({
      runtime,
      pendingCompletionNotifications,
      emittedEventKeys,
      nowMs: pending.deadlineMs,
      preparePendingCompletionNotification: ({ pending: pendingEvent }) => {
        prepareCalls.push(`repeat:${pendingEvent.dedupeKey}`);
        return { event: pendingEvent, title: "Prepared completion (duplicate)" };
      },
      hasCompletionReceipt: (input) => {
        receiptCalls.push(input);
        return false;
      },
      emitPreparedCompletionNotification: (input) => {
        emitCalls.push(input);
      },
    });

    assert(prepareCalls.length === 1, "prepare should not run twice");
    assert(receiptCalls.length === 1, "receipt check should run at deadline");
    assert(receiptCalls[0].sessionId === event.sessionId, "receipt sessionId mismatch");
    assert(receiptCalls[0].turnId === event.turnId, "receipt turnId mismatch");
    assert(receiptCalls[0].eventName === "Stop", "receipt eventName mismatch");
    assert(receiptCalls[0].nowMs === pending.deadlineMs, "receipt nowMs mismatch");
    assert(emitCalls.length === 1, "completion should emit when receipt is absent");
    assert(
      emitCalls[0].prepared && emitCalls[0].prepared.title === "Prepared completion",
      "emit should use prepared completion payload"
    );
    assert(emitCalls[0].origin === "pending", "emit origin should be pending");
    assert(emitCalls[0].emittedEventKeys === emittedEventKeys, "emit should forward emitted key set");
    assert(
      !pendingCompletionNotifications.has(event.dedupeKey),
      "pending completion should be removed after emit"
    );
    assert(
      logs.some((line) => line.includes("queued completion pending")),
      "queue path should log pending completion enqueue"
    );
  });

  test("pending completion fallback drops queued completion when matching receipt exists", () => {
    const completionPending = loadCompletionPending();
    const pendingCompletionNotifications = new Map();
    const emittedEventKeys = new Map();
    const logs = [];
    const runtime = {
      log: (line) => logs.push(line),
    };
    const event = {
      sourceId: "codex-session-watch",
      sessionId: "receipt-session",
      turnId: "receipt-turn",
      eventName: "Stop",
      eventType: "task_complete",
    };
    const emitCalls = [];
    const prepareCalls = [];

    completionPending.queuePendingCompletionNotification({
      runtime,
      pendingCompletionNotifications,
      emittedEventKeys,
      event,
      nowMs: 2_000,
    });

    const key = completionPending.buildPendingCompletionKey(event);
    const pending = pendingCompletionNotifications.get(key);
    assert(pending, "expected queued completion candidate");

    completionPending.flushPendingCompletionNotifications({
      runtime,
      pendingCompletionNotifications,
      emittedEventKeys,
      nowMs: pending.deadlineMs,
      preparePendingCompletionNotification: ({ pending: pendingEvent }) => {
        prepareCalls.push(pendingEvent.turnId);
        return { event: pendingEvent, title: "Prepared receipt candidate" };
      },
      hasCompletionReceipt: () => true,
      emitPreparedCompletionNotification: (input) => {
        emitCalls.push(input);
      },
    });

    assert(prepareCalls.length === 1, "prepare should still run once before receipt check");
    assert(emitCalls.length === 0, "matching receipt should suppress fallback emit");
    assert(
      !pendingCompletionNotifications.has(key),
      "pending completion should be dropped when receipt exists"
    );
    assert(
      logs.some((line) => line.includes("reason=receipt_found")),
      "drop path should log receipt_found reason"
    );
  });

  test("pending completion fallback skips queueing when emitted key already exists in map", () => {
    const completionPending = loadCompletionPending();
    const pendingCompletionNotifications = new Map();
    const emittedEventKeys = new Map([["queued-session|queued-turn|Stop", Date.now()]]);
    const runtime = { log: () => {} };

    completionPending.queuePendingCompletionNotification({
      runtime,
      pendingCompletionNotifications,
      emittedEventKeys,
      event: {
        sourceId: "codex-session-watch",
        sessionId: "queued-session",
        turnId: "queued-turn",
        eventName: "Stop",
        eventType: "task_complete",
        dedupeKey: "queued-session|queued-turn|Stop",
      },
      nowMs: 3_000,
    });

    assert(
      pendingCompletionNotifications.size === 0,
      "existing emitted map key should skip pending completion queue"
    );
  });

  test("handleSessionRecord queues rollout task_complete into pending completion state", () => {
    const handlers = loadSessionWatchHandlers();
    const pendingCompletionNotifications = new Map();

    handlers.handleSessionRecord(
      {
        filePath:
          "C:\\Users\\ericali\\.codex\\sessions\\2026\\04\\09\\rollout-2026-04-09T16-20-00-session-stop.jsonl",
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

    assert(pendingCompletionNotifications.size === 1, "expected queued completion pending candidate");
    const pending = pendingCompletionNotifications.values().next().value;
    assert(pending.eventName === "Stop", "expected Stop event to be queued");
    assert(pending.eventType === "task_complete", "expected task_complete fallback candidate");
  });

  test("prepared completion fallback reuses notify runtime and emits one Stop notification", () => {
    const completionNotify = loadCompletionNotify();
    const emitted = [];
    const fakeChild = { on: () => {} };
    const runtimeObject = { log: () => {} };
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
      runtime: runtimeObject,
      emittedEventKeys: new Map(),
      origin: "pending",
      emitNotificationImpl: (payload) => {
        emitted.push(payload);
        return fakeChild;
      },
    });

    assert(didEmit === true, "expected fallback emit to return true");
    assert(emitted.length === 1, "expected a single fallback notification emit");
    assert(emitted[0].eventName === "Stop", "expected Stop notification payload");
    assert(emitted[0].runtime === runtimeObject, "expected runtime object forwarded to notify call");
  });
};
