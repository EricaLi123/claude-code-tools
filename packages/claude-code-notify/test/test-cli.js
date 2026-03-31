#!/usr/bin/env node

// Lightweight tests for claude-code-notify
// Run: node test/test-cli.js

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const cli = require(path.join(ROOT, "bin", "cli.js"));
const { normalizeIncomingNotification } = require(path.join(ROOT, "lib", "notification-sources.js"));
const sidecarState = require(path.join(ROOT, "lib", "codex-sidecar-state.js"));

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "assertion failed");
  }
}

function skip(name, reason) {
  console.log(`  SKIP  ${name}`);
  console.log(`        ${reason}`);
  skipped++;
}

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function assertLocalMarkdownLinksExist(relPath) {
  const absPath = path.join(ROOT, relPath);
  const content = fs.readFileSync(absPath, "utf8");
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  let match;

  while ((match = linkPattern.exec(content)) !== null) {
    const target = match[1].trim();
    if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) {
      continue;
    }

    const withoutFragment = target.split("#")[0];
    if (!withoutFragment) {
      continue;
    }

    const resolved = path.resolve(path.dirname(absPath), withoutFragment);
    assert(fs.existsSync(resolved), `${relPath} broken link: ${target}`);
  }
}

function normalizeTestPath(value) {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

let canSpawnChildren = true;
try {
  execFileSync(process.execPath, ["--version"], { stdio: "pipe" });
} catch (error) {
  if (error && error.code === "EPERM") {
    canSpawnChildren = false;
  } else {
    throw error;
  }
}

console.log("\n--- File structure ---");

[
  "bin/cli.js",
  "lib/codex-sidecar-state.js",
  "lib/notification-sources.js",
  "postinstall.js",
  "scripts/find-hwnd.ps1",
  "scripts/get-shell-pid.ps1",
  "scripts/codex-notify-wrapper.vbs",
  "scripts/notify.ps1",
  "scripts/register-protocol.ps1",
  "scripts/start-hidden.vbs",
  "scripts/start-tab-color-watcher.ps1",
  "scripts/tab-color-watcher.ps1",
  "docs/development.md",
  "docs/architecture.md",
  "docs/codex-approval.md",
  "docs/windows-runtime.md",
  "docs/history/README.md",
  "docs/history/codex-notify-findings.md",
  "docs/history/codex-approval-notification-session-2026-03-18.md",
  "docs/history/tab-color-history.md",
].forEach((relPath) => {
  test(`${relPath} exists`, () => {
    assert(fs.existsSync(path.join(ROOT, relPath)), `${relPath} missing`);
  });
});

console.log("\n--- package.json ---");

const pkg = JSON.parse(read("package.json"));
const DEV_DOCS_URL =
  "https://github.com/EricaLi123/claude-code-tools/blob/main/packages/claude-code-notify/docs/development.md";

test("postinstall script points to node postinstall.js", () => {
  assert(pkg.scripts && pkg.scripts.postinstall === "node postinstall.js");
});

test("package keeps zero runtime dependencies", () => {
  assert(Object.keys(pkg.dependencies || {}).length === 0, "unexpected runtime dependencies");
});

test("files includes postinstall.js", () => {
  assert(Array.isArray(pkg.files) && pkg.files.includes("postinstall.js"));
});

console.log("\n--- Content checks ---");

const cliContent = read("bin/cli.js");
const notifyContent = read("scripts/notify.ps1");
const codexWrapperContent = read("scripts/codex-notify-wrapper.vbs");
const postinstallContent = read("postinstall.js");
const startHiddenContent = read("scripts/start-hidden.vbs");
const watcherContent = read("scripts/tab-color-watcher.ps1");
test("cli.js resolves hwnd, shell pid, and spawns watcher through launcher", () => {
  assert(cliContent.includes("find-hwnd.ps1"));
  assert(cliContent.includes("get-shell-pid.ps1"));
  assert(cliContent.includes("start-tab-color-watcher.ps1"));
  assert(cliContent.includes("--shell-pid"));
  assert(cliContent.includes("launcher exited status="));
  assert(cliContent.includes("WatcherPidFile"));
});

test("cli.js includes codex watcher mode", () => {
  assert(cliContent.includes("codex-watch"));
  assert(cliContent.includes('"app-server"'));
  assert(cliContent.includes("thread/status/changed"));
  assert(cliContent.includes("waitingOnApproval"));
  assert(cliContent.includes("thread/list"));
  assert(!cliContent.includes("Codex Needs Approval"));
});

test("cli.js includes codex session watcher mode", () => {
  assert(cliContent.includes("codex-session-watch"));
  assert(cliContent.includes("exec_approval_request"));
  assert(cliContent.includes("request_permissions"));
  assert(cliContent.includes("apply_patch_approval_request"));
  assert(cliContent.includes("codex-tui.log"));
  assert(cliContent.includes('ToolCall: shell_command '));
  assert(cliContent.includes('"sandbox_permissions":"require_escalated"'));
  assert(!cliContent.includes("apply_patch_outside_workspace"));
  assert(cliContent.includes("sessionsDir"));
  assert(cliContent.includes('acquireSingleInstanceLock("codex-session-watch"'));
  assert(cliContent.includes("start-hidden.vbs"));
});

test("cli.js includes codex mcp sidecar mode", () => {
  assert(cliContent.includes("codex-mcp-sidecar"));
  assert(cliContent.includes("Run a minimal MCP sidecar"));
  assert(cliContent.includes("ensureCodexSessionWatchRunning"));
  assert(cliContent.includes("codex-session-watch already running"));
  assert(cliContent.includes('case "initialize"'));
  assert(cliContent.includes('case "tools/list"'));
  assert(cliContent.includes('case "resources/list"'));
  assert(cliContent.includes('case "prompts/list"'));
});

test("sidecar candidate picker prefers the closest unambiguous rollout", () => {
  const candidate = cli.pickSidecarSessionCandidate([
    {
      sessionId: "session-a",
      filePath: "rollout-a.jsonl",
      score: 2000,
      referenceStartedAtMs: 2000,
    },
    {
      sessionId: "session-b",
      filePath: "rollout-b.jsonl",
      score: 12000,
      referenceStartedAtMs: 12000,
    },
  ]);

  assert(candidate);
  assert(candidate.sessionId === "session-a");
});

test("sidecar candidate picker rejects ambiguous close matches", () => {
  const candidate = cli.pickSidecarSessionCandidate([
    {
      sessionId: "session-a",
      filePath: "rollout-a.jsonl",
      score: 2000,
      referenceStartedAtMs: 2000,
    },
    {
      sessionId: "session-b",
      filePath: "rollout-b.jsonl",
      score: 3500,
      referenceStartedAtMs: 3500,
    },
  ]);

  assert(candidate === null);
});

test("sidecar candidate picker prefers future rollout when scores tie", () => {
  const candidate = cli.pickSidecarSessionCandidate([
    {
      sessionId: "session-past",
      filePath: "rollout-past.jsonl",
      score: 2000,
      referenceStartedAtMs: 1000,
      isFutureMatch: false,
    },
    {
      sessionId: "session-future",
      filePath: "rollout-future.jsonl",
      score: 2000,
      referenceStartedAtMs: 1500,
      isFutureMatch: true,
    },
  ]);

  assert(candidate);
  assert(candidate.sessionId === "session-future");
});

test("sidecar resolver can match a resumed old rollout using recent activity time", () => {
  const fixtureRoot = path.join(ROOT, `.tmp-sidecar-resume-${Date.now()}`);
  const sessionsDir = path.join(fixtureRoot, "2026", "03", "20");
  const rolloutPath = path.join(
    sessionsDir,
    "rollout-2026-03-20T13-51-32-session-resume-test.jsonl"
  );
  const recentIso = new Date().toISOString();

  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: "2026-03-20T13:51:32.000Z",
          type: "session_meta",
          payload: {
            id: "session-resume-test",
            cwd: "D:\\XAGIT\\leyserkids",
          },
        }),
        JSON.stringify({
          timestamp: recentIso,
          type: "turn_context",
          payload: {
            cwd: "D:\\XAGIT\\leyserkids",
          },
        }),
      ].join("\n"),
      "utf8"
    );

    const candidate = cli.resolveSidecarSessionCandidate({
      cwd: "D:\\XAGIT\\leyserkids",
      sessionsDir: fixtureRoot,
      startedAtMs: Date.parse(recentIso),
      log: () => {},
    });

    assert(candidate, "expected a resolved sidecar candidate");
    assert(candidate.sessionId === "session-resume-test");
    assert(candidate.referenceKind === "latest_event");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("mcp sidecar writes JSON-RPC responses", () => {
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };

  try {
    cli.handleMcpServerMessage({ id: "req-1", method: "ping" }, () => {});
  } finally {
    process.stdout.write = originalWrite;
  }

  assert(writes.length === 1);
  const payload = JSON.parse(writes[0]);
  assert(payload.jsonrpc === "2.0");
  assert(payload.id === "req-1");
  assert(payload.result && typeof payload.result === "object");
  assert(Object.keys(payload.result).length === 0);
});

test("sidecar state lookup returns exact session mappings after sidecar exit", () => {
  const recordId = `test-sidecar-${process.pid}-${Date.now()}`;
  const sessionId = `test-session-${Date.now()}`;

  try {
    sidecarState.writeSidecarRecord({
      recordId,
      pid: 999999,
      parentPid: process.ppid,
      cwd: "D:\\XAGIT\\claude-code-tools",
      sessionId,
      startedAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
      hwnd: 1234,
      shellPid: 5678,
      isWindowsTerminal: true,
    });

    const terminal = sidecarState.findSidecarTerminalContextForSession(sessionId);
    assert(terminal);
    assert(terminal.sessionId === sessionId);
    assert(terminal.hwnd === 1234);
    assert(terminal.shellPid === 5678);
    assert(terminal.isWindowsTerminal === true);
  } finally {
    sidecarState.deleteSidecarRecord(recordId);
  }
});

test("sidecar prune keeps fresh resolved records even when the sidecar pid is gone", () => {
  const recordId = `test-sidecar-fresh-${process.pid}-${Date.now()}`;
  const sessionId = `test-session-fresh-${Date.now()}`;

  try {
    sidecarState.writeSidecarRecord({
      recordId,
      pid: 999999,
      parentPid: process.ppid,
      cwd: "D:\\XAGIT\\claude-code-tools",
      sessionId,
      startedAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
      hwnd: 4321,
      shellPid: 8765,
      isWindowsTerminal: true,
    });

    sidecarState.pruneStaleSidecarRecords();

    const terminal = sidecarState.findSidecarTerminalContextForSession(sessionId);
    assert(terminal);
    assert(terminal.hwnd === 4321);
    assert(terminal.shellPid === 8765);
  } finally {
    sidecarState.deleteSidecarRecord(recordId);
  }
});

test("sidecar prune keeps older exact session records for long-lived sessions", () => {
  const recordId = `test-sidecar-long-session-${process.pid}-${Date.now()}`;
  const sessionId = `test-session-long-${Date.now()}`;
  const recordPath = path.join(sidecarState.getSidecarStateDir(), `${recordId}.json`);
  const oldIso = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  try {
    sidecarState.writeSidecarRecord({
      recordId,
      pid: 999999,
      parentPid: process.ppid,
      cwd: "D:\\XAGIT\\claude-code-tools",
      sessionId,
      startedAt: oldIso,
      resolvedAt: oldIso,
      hwnd: 6543,
      shellPid: 7654,
      isWindowsTerminal: true,
    });

    const persisted = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    persisted.startedAt = oldIso;
    persisted.updatedAt = oldIso;
    persisted.resolvedAt = oldIso;
    persisted.lastMatchedAt = "";
    fs.writeFileSync(recordPath, JSON.stringify(persisted, null, 2), "utf8");

    sidecarState.pruneStaleSidecarRecords();

    const terminal = sidecarState.findSidecarTerminalContextForSession(sessionId);
    assert(terminal, "expected exact session record to survive prune");
    assert(terminal.hwnd === 6543);
    assert(terminal.shellPid === 7654);
  } finally {
    sidecarState.deleteSidecarRecord(recordId);
  }
});

test("sidecar exact session matches refresh persisted record freshness", () => {
  const recordId = `test-sidecar-refresh-${process.pid}-${Date.now()}`;
  const sessionId = `test-session-refresh-${Date.now()}`;
  const recordPath = path.join(sidecarState.getSidecarStateDir(), `${recordId}.json`);
  const oldIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  try {
    sidecarState.writeSidecarRecord({
      recordId,
      pid: 999999,
      parentPid: process.ppid,
      cwd: "D:\\XAGIT\\claude-code-tools",
      sessionId,
      startedAt: oldIso,
      resolvedAt: oldIso,
      hwnd: 7654,
      shellPid: 8765,
      isWindowsTerminal: true,
    });

    const persisted = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    persisted.startedAt = oldIso;
    persisted.updatedAt = oldIso;
    persisted.resolvedAt = oldIso;
    persisted.lastMatchedAt = "";
    fs.writeFileSync(recordPath, JSON.stringify(persisted, null, 2), "utf8");

    const terminal = sidecarState.findSidecarTerminalContextForSession(sessionId);
    assert(terminal, "expected exact session lookup to succeed");

    const refreshed = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    assert(Date.parse(refreshed.updatedAt) > Date.parse(oldIso));
    assert(Date.parse(refreshed.lastMatchedAt) > Date.parse(oldIso));
  } finally {
    sidecarState.deleteSidecarRecord(recordId);
  }
});

test("approval terminal resolution falls back to project-dir hwnd when no exact session mapping exists", () => {
  const recordId = `test-sidecar-project-${process.pid}-${Date.now()}`;
  const projectDir = path.join(ROOT, `.tmp-sidecar-project-${Date.now()}`);
  const recordCwd = path.join(projectDir, "subdir");

  try {
    sidecarState.writeSidecarRecord({
      recordId,
      pid: process.pid,
      parentPid: process.ppid,
      cwd: recordCwd,
      sessionId: "",
      startedAt: new Date().toISOString(),
      resolvedAt: "",
      hwnd: 2468,
      shellPid: 1357,
      isWindowsTerminal: true,
    });

    const terminal = cli.resolveApprovalTerminalContext({
      sessionId: `missing-session-${Date.now()}`,
      projectDir,
      fallbackTerminal: {
        hwnd: null,
        shellPid: null,
        isWindowsTerminal: false,
      },
      log: () => {},
    });

    assert(terminal);
    assert(terminal.hwnd === 2468);
    assert(terminal.shellPid === null);
    assert(terminal.isWindowsTerminal === false);
  } finally {
    sidecarState.deleteSidecarRecord(recordId);
  }
});

test("session watcher queues response_item function_call approvals for pending confirmation", () => {
  const event = cli.buildCodexSessionEvent(
    {
      filePath: "C:\\Users\\ericali\\.codex\\sessions\\2026\\03\\20\\rollout-2026-03-20T12-14-50-session-1.jsonl",
      sessionId: "session-1",
      cwd: "C:\\Users\\ericali",
      turnId: "turn-1",
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell_command",
        call_id: "call-1",
        arguments: JSON.stringify({
          command: "Get-Date",
          sandbox_permissions: "require_escalated",
          workdir: "C:\\Users\\ericali",
        }),
      },
    }
  );

  assert(event);
  assert(event.eventName === "PermissionRequest");
  assert(event.eventType === "require_escalated_tool_call");
  assert(event.approvalDispatch === "pending");
  assert(event.turnId === "turn-1");
  assert(event.dedupeKey === "session-1|exec|turn-1|shell_command:Get-Date");
});

test("session watcher ignores non-escalated function_call response items", () => {
  const event = cli.buildCodexSessionEvent(
    {
      filePath: "C:\\Users\\ericali\\.codex\\sessions\\2026\\03\\20\\rollout-2026-03-20T12-14-50-session-2.jsonl",
      sessionId: "session-2",
      cwd: "C:\\Users\\ericali",
      turnId: "turn-2",
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell_command",
        call_id: "call-2",
        arguments: JSON.stringify({
          command: "Get-Date",
          workdir: "C:\\Users\\ericali",
        }),
      },
    }
  );

  assert(event === null);
});

test("tui watcher recognizes shell approvals from ToolCall lines instead of exec_approval dispatch", () => {
  const event = cli.buildCodexTuiApprovalEvent(
    { applyPatchCapture: null },
    '2026-03-20T04:15:29.835774Z  INFO session_loop{thread_id=session-3}:submission_dispatch{otel.name="op.dispatch.user_turn" submission.id="submission-3" codex.op="user_turn"}:turn{otel.name="session_task.turn" thread.id=session-3 turn.id=turn-3 model=gpt-5.4}: codex_core::stream_events_utils: ToolCall: shell_command {"command":"Get-Date","sandbox_permissions":"require_escalated","workdir":"C:\\\\Users\\\\ericali"} thread_id=session-3',
    {
      sessionProjectDirs: new Map([["session-3", "C:\\Users\\ericali"]]),
      sessionApprovalContexts: new Map(),
    }
  );

  assert(event);
  assert(event.eventType === "require_escalated_tool_call");
  assert(event.approvalDispatch === "pending");
  assert(event.dedupeKey === "session-3|exec|turn-3|shell_command:Get-Date");
});

test("approved PowerShell command rules suppress exact require_escalated shell commands", () => {
  const rules = cli.parseApprovedCommandRules(
    'prefix_rule(pattern=["C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe", "-Command", "rg -n \\"model|openrouter|provider|apiKey|baseUrl|llm\\" \\"D:\\\\XAGIT\\\\kids-tools\\\\apps\\\\ai-ui-case-runner\\""], decision="allow")'
  );

  assert(rules.length === 1, "expected one parsed approved rule");
  assert(
    cli.getCodexRequireEscalatedSuppressionReason({
      event: {
        eventType: "require_escalated_tool_call",
        toolArgs: {
          command: 'rg -n "model|openrouter|provider|apiKey|baseUrl|llm" "D:\\XAGIT\\kids-tools\\apps\\ai-ui-case-runner"',
        },
      },
      approvalPolicy: "",
      sandboxPolicy: null,
      approvedCommandRules: rules,
    }) === "approved_rule"
  );
});

test("approved PowerShell command rules suppress prefix_rule-based require_escalated shell commands", () => {
  const rules = cli.parseApprovedCommandRules(
    'prefix_rule(pattern=["C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe", "-Command", "Get-ChildItem -Recurse -File \\"D:\\\\XAGIT\\\\kids-tools\\\\apps\\\\ai-ui-case-runner\\" | Select-Object -ExpandProperty FullName"], decision="allow")'
  );

  assert(rules.length === 1, "expected one parsed approved rule");
  assert(
    cli.getCodexRequireEscalatedSuppressionReason({
      event: {
        eventType: "require_escalated_tool_call",
        toolArgs: {
          command:
            'Get-ChildItem -Recurse -File "D:\\XAGIT\\kids-tools\\apps\\ai-ui-case-runner" | Select-Object -ExpandProperty FullName',
          prefix_rule: [
            "Get-ChildItem",
            "-Recurse",
            "-File",
            "D:\\XAGIT\\kids-tools\\apps\\ai-ui-case-runner",
          ],
        },
      },
      approvalPolicy: "",
      sandboxPolicy: null,
      approvedCommandRules: rules,
    }) === "approved_rule"
  );
});

test("approved command rules do not suppress write require_escalated shell commands", () => {
  const rules = cli.parseApprovedCommandRules(
    'prefix_rule(pattern=["C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe", "-Command", "git add -- README.md test/test-cli.js; git commit -m \\"Trim README to user-facing setup\\""], decision="allow")'
  );

  assert(rules.length === 1, "expected one parsed approved rule");
  assert(
    cli.getCodexRequireEscalatedSuppressionReason({
      event: {
        eventType: "require_escalated_tool_call",
        toolArgs: {
          command: 'git add -- README.md test/test-cli.js; git commit -m "Trim README to user-facing setup"',
          prefix_rule: ["git", "commit"],
        },
      },
      approvalPolicy: "",
      sandboxPolicy: null,
      approvedCommandRules: rules,
    }) === ""
  );
});

test("extractCommandApprovalRoots normalizes absolute file, directory, and inline node script roots", () => {
  const packageRoot = normalizeTestPath(ROOT);
  const binDir = normalizeTestPath(path.join(ROOT, "bin"));
  const fileRoots = cli.extractCommandApprovalRoots({
    command: `Get-Content -Path '${path.join(ROOT, "bin", "cli.js")}'`,
    workdir: ROOT,
  });
  const dirRoots = cli.extractCommandApprovalRoots({
    command: `Get-ChildItem '${path.join(ROOT, "bin")}' -File | Select-Object -ExpandProperty FullName`,
    workdir: ROOT,
  });
  const inlineNodeRoots = cli.extractCommandApprovalRoots({
    command:
      `@'\nconst root = '${ROOT.replace(/\\/g, "/")}';\nwriteAsciiJs(path.join(root, 'bin/cli.js'), 'x');\n'@ | node -`,
    workdir: ROOT,
  });

  assert(fileRoots.includes(packageRoot));
  assert(dirRoots.includes(packageRoot));
  assert(inlineNodeRoots.includes(packageRoot));
  assert(!inlineNodeRoots.some((root) => root.includes("@\nconst root")));
  assert(fileRoots.includes(packageRoot) && !fileRoots.includes(binDir));
});

test("confirmed session approval suppresses later read-only require_escalated commands in the same root", () => {
  const recentRequireEscalatedEvents = new Map();
  const sessionApprovalGrants = new Map();
  const nowMs = 1_000_000;
  const packageRoot = ROOT;

  cli.rememberRecentRequireEscalatedEvent(
    recentRequireEscalatedEvents,
    {
      dedupeKey: "session-a|exec|turn-a|Get-Content",
      eventType: "require_escalated_tool_call",
      projectDir: packageRoot,
      sessionId: "session-a",
      toolArgs: {
        command: `Get-Content -Path '${path.join(packageRoot, "bin", "cli.js")}'`,
        workdir: packageRoot,
      },
      turnId: "turn-a",
    },
    nowMs - 1_000
  );

  const added = cli.confirmSessionApprovalForRecentEvents({
    recentRequireEscalatedEvents,
    runtime: { log: () => {} },
    sessionApprovalGrants,
    sessionId: "session-a",
    source: "approved_rule_saved",
    turnId: "turn-a",
    nowMs,
  });

  assert(added === 1, "expected one confirmed root");
  assert(
    cli.getSessionRequireEscalatedSuppressionReason({
      event: {
        eventType: "require_escalated_tool_call",
        sessionId: "session-a",
        toolArgs: {
          command: `Get-ChildItem '${path.join(packageRoot, "lib")}' -File | Select-Object -ExpandProperty FullName`,
          workdir: packageRoot,
        },
      },
      nowMs: nowMs + 500,
      sessionApprovalGrants,
    }) === "session_recent_read_grant"
  );
});

test("read-only require_escalated commands use a longer pending grace window", () => {
  const readOnlyGraceMs = cli.getCodexApprovalNotifyGraceMs({
    eventType: "require_escalated_tool_call",
    toolArgs: {
      command: `Get-Content -Path '${path.join(ROOT, "bin", "cli.js")}'`,
      workdir: ROOT,
    },
  });
  const writeGraceMs = cli.getCodexApprovalNotifyGraceMs({
    eventType: "require_escalated_tool_call",
    toolArgs: {
      command: `node "${path.join(ROOT, "bin", "cli.js")}" --help`,
      workdir: ROOT,
    },
  });

  assert(readOnlyGraceMs > writeGraceMs);
});

test("pending approval batching collapses sibling require_escalated calls from the same turn", () => {
  const pendingApprovalNotifications = new Map();
  const pendingApprovalCallIds = new Map();

  pendingApprovalNotifications.set("approval-a", {
    dedupeKey: "approval-a",
    eventType: "require_escalated_tool_call",
    sessionId: "session-batch",
    turnId: "turn-batch",
    callId: "call-a",
    pendingSinceMs: 1_000,
    deadlineMs: 2_000,
  });
  pendingApprovalNotifications.set("approval-b", {
    dedupeKey: "approval-b",
    eventType: "require_escalated_tool_call",
    sessionId: "session-batch",
    turnId: "turn-batch",
    callId: "call-b",
    pendingSinceMs: 1_120,
    deadlineMs: 6_120,
  });
  pendingApprovalNotifications.set("approval-other", {
    dedupeKey: "approval-other",
    eventType: "require_escalated_tool_call",
    sessionId: "session-batch",
    turnId: "turn-other",
    callId: "call-other",
    pendingSinceMs: 1_080,
    deadlineMs: 2_080,
  });
  pendingApprovalCallIds.set("call-a", "approval-a");
  pendingApprovalCallIds.set("call-b", "approval-b");
  pendingApprovalCallIds.set("call-other", "approval-other");

  const batch = cli.drainPendingApprovalBatch({
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    representativeKey: "approval-a",
  });

  assert(batch.batchKey === "session-batch|turn-batch|require_escalated_tool_call");
  assert(batch.count === 2);
  assert(batch.representative && batch.representative.dedupeKey === "approval-a");
  assert(!pendingApprovalNotifications.has("approval-a"));
  assert(!pendingApprovalNotifications.has("approval-b"));
  assert(pendingApprovalNotifications.has("approval-other"));
  assert(!pendingApprovalCallIds.has("call-a"));
  assert(!pendingApprovalCallIds.has("call-b"));
  assert(pendingApprovalCallIds.get("call-other") === "approval-other");
});

test("pending approval batching keeps later same-turn require_escalated calls separate", () => {
  const pendingApprovalNotifications = new Map();
  const pendingApprovalCallIds = new Map();

  pendingApprovalNotifications.set("approval-a", {
    dedupeKey: "approval-a",
    eventType: "require_escalated_tool_call",
    sessionId: "session-batch",
    turnId: "turn-batch",
    callId: "call-a",
    pendingSinceMs: 1_000,
    deadlineMs: 2_000,
  });
  pendingApprovalNotifications.set("approval-late", {
    dedupeKey: "approval-late",
    eventType: "require_escalated_tool_call",
    sessionId: "session-batch",
    turnId: "turn-batch",
    callId: "call-late",
    pendingSinceMs: 1_800,
    deadlineMs: 2_800,
  });
  pendingApprovalCallIds.set("call-a", "approval-a");
  pendingApprovalCallIds.set("call-late", "approval-late");

  const batch = cli.drainPendingApprovalBatch({
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    representativeKey: "approval-a",
  });

  assert(batch.batchKey === "session-batch|turn-batch|require_escalated_tool_call");
  assert(batch.count === 1);
  assert(!pendingApprovalNotifications.has("approval-a"));
  assert(pendingApprovalNotifications.has("approval-late"));
  assert(!pendingApprovalCallIds.has("call-a"));
  assert(pendingApprovalCallIds.get("call-late") === "approval-late");
});

test("confirmation suppressions cancel pending read-only approvals before they emit", () => {
  const recentRequireEscalatedEvents = new Map();
  const sessionApprovalGrants = new Map();
  const pendingApprovalNotifications = new Map();
  const pendingApprovalCallIds = new Map();
  const nowMs = 3_000_000;
  const packageRoot = ROOT;

  cli.rememberRecentRequireEscalatedEvent(
    recentRequireEscalatedEvents,
    {
      dedupeKey: "session-c|exec|turn-c|Get-Content",
      eventType: "require_escalated_tool_call",
      projectDir: packageRoot,
      sessionId: "session-c",
      toolArgs: {
        command: `Get-Content -Path '${path.join(packageRoot, "README.md")}'`,
        workdir: packageRoot,
      },
      turnId: "turn-c",
    },
    nowMs - 1_000
  );

  pendingApprovalNotifications.set("pending-read", {
    dedupeKey: "pending-read",
    eventType: "require_escalated_tool_call",
    sessionId: "session-c",
    toolArgs: {
      command: `Get-ChildItem '${path.join(packageRoot, "lib")}' -File | Select-Object -ExpandProperty FullName`,
      workdir: packageRoot,
    },
    turnId: "turn-c",
  });
  pendingApprovalNotifications.set("pending-write", {
    dedupeKey: "pending-write",
    eventType: "require_escalated_tool_call",
    sessionId: "session-c",
    toolArgs: {
      command: `node "${path.join(packageRoot, "bin", "cli.js")}" --help`,
      workdir: packageRoot,
    },
    turnId: "turn-c",
    callId: "call-write",
  });
  pendingApprovalCallIds.set("call-write", "pending-write");

  cli.confirmSessionApprovalForRecentEvents({
    recentRequireEscalatedEvents,
    runtime: { log: () => {} },
    sessionApprovalGrants,
    sessionId: "session-c",
    source: "tui_exec_approval",
    turnId: "turn-c",
    nowMs,
  });

  const cancelled = cli.cancelPendingApprovalNotificationsBySuppression({
    runtime: { log: () => {} },
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    sessionId: "session-c",
    turnId: "turn-c",
    nowMs,
    sessionApprovalGrants,
  });

  assert(cancelled === 1);
  assert(!pendingApprovalNotifications.has("pending-read"));
  assert(pendingApprovalNotifications.has("pending-write"));
  assert(pendingApprovalCallIds.get("call-write") === "pending-write");
});

test("session approval suppression does not hide different roots or non-read-only commands", () => {
  const recentRequireEscalatedEvents = new Map();
  const sessionApprovalGrants = new Map();
  const nowMs = 2_000_000;
  const packageRoot = ROOT;
  const otherRoot = "C:\\other-project";

  cli.rememberRecentRequireEscalatedEvent(
    recentRequireEscalatedEvents,
    {
      dedupeKey: "session-b|exec|turn-b|Get-Content",
      eventType: "require_escalated_tool_call",
      projectDir: packageRoot,
      sessionId: "session-b",
      toolArgs: {
        command: `Get-Content -Path '${path.join(packageRoot, "README.md")}'`,
        workdir: packageRoot,
      },
      turnId: "turn-b",
    },
    nowMs - 1_000
  );

  cli.confirmSessionApprovalForRecentEvents({
    recentRequireEscalatedEvents,
    runtime: { log: () => {} },
    sessionApprovalGrants,
    sessionId: "session-b",
    source: "tui_exec_approval",
    turnId: "turn-b",
    nowMs,
  });

  assert(
    cli.getSessionRequireEscalatedSuppressionReason({
      event: {
        eventType: "require_escalated_tool_call",
        sessionId: "session-b",
        toolArgs: {
          command: `Get-Content -Path '${path.join(otherRoot, "README.md")}'`,
          workdir: otherRoot,
        },
      },
      nowMs: nowMs + 500,
      sessionApprovalGrants,
    }) === ""
  );

  assert(
    cli.getSessionRequireEscalatedSuppressionReason({
      event: {
        eventType: "require_escalated_tool_call",
        sessionId: "session-b",
        toolArgs: {
          command: `node "${path.join(packageRoot, "bin", "cli.js")}" --help`,
          workdir: packageRoot,
        },
      },
      nowMs: nowMs + 500,
      sessionApprovalGrants,
    }) === ""
  );
});

test("approval_policy=never suppresses require_escalated approval notifications", () => {
  assert(
    cli.getCodexRequireEscalatedSuppressionReason({
      event: {
        eventType: "require_escalated_tool_call",
        toolArgs: {
          command: "Get-Date",
        },
      },
      approvalPolicy: "never",
      sandboxPolicy: null,
      approvedCommandRules: [],
    }) === "approval_policy_never"
  );
});

test("danger-full-access suppresses require_escalated approval notifications", () => {
  assert(
    cli.getCodexRequireEscalatedSuppressionReason({
      event: {
        eventType: "require_escalated_tool_call",
        toolArgs: {
          command: "Get-Date",
        },
      },
      approvalPolicy: "",
      sandboxPolicy: {
        type: "danger-full-access",
      },
      approvedCommandRules: [],
    }) === "danger_full_access"
  );
});

test("session watcher recognizes explicit apply_patch approval events from rollout JSONL", () => {
  const event = cli.buildCodexSessionEvent(
    {
      filePath: "C:\\Users\\ericali\\.codex\\sessions\\2026\\03\\20\\rollout-2026-03-20T12-14-50-session-4.jsonl",
      sessionId: "session-4",
      cwd: "C:\\Users\\ericali",
      turnId: "turn-4",
    },
    {
      type: "event_msg",
      payload: {
        type: "apply_patch_approval_request",
        turn_id: "turn-4",
        call_id: "call-4",
        approval_id: "approval-4",
        cwd: "D:\\XAGIT\\claude-code-tools\\packages\\claude-code-notify",
      },
    }
  );

  assert(event);
  assert(event.eventType === "apply_patch_approval_request");
  assert(event.dedupeKey === "session-4|patch|turn-4|");
});

test("tui watcher ignores apply_patch tool calls because they are not reliable approval signals", () => {
  const event = cli.buildCodexTuiApprovalEvent(
    {},
    '2026-03-20T09:24:55.432022Z  INFO session_loop{thread_id=session-5}:submission_dispatch{otel.name="op.dispatch.user_turn" submission.id="submission-5" codex.op="user_turn"}:turn{otel.name="session_task.turn" thread.id=session-5 turn.id=turn-5 model=gpt-5.4}: codex_core::stream_events_utils: ToolCall: apply_patch *** Begin Patch',
    {
      sessionProjectDirs: new Map([["session-5", "C:\\Users\\ericali"]]),
    }
  );

  assert(event === null);
});

test("notification source normalizer recognizes Claude hook payloads", () => {
  const normalized = normalizeIncomingNotification({
    argv: [],
    stdinData: JSON.stringify({
      hook_event_name: "PermissionRequest",
      session_id: "claude-session-1",
      title: "Claude Needs Permission",
    }),
    env: {},
  });

  assert(normalized.sourceId === "claude-hook");
  assert(normalized.source === "Claude");
  assert(normalized.eventName === "PermissionRequest");
  assert(normalized.sessionId === "claude-session-1");
  assert(normalized.title === "Needs Approval");
  assert(normalized.message === "Waiting for your approval");
  assert(normalized.projectDir === "");
});

test("notification source normalizer canonicalizes source-prefixed stop titles", () => {
  const normalized = normalizeIncomingNotification({
    argv: [],
    stdinData: JSON.stringify({
      hook_event_name: "Stop",
      session_id: "claude-session-2",
      title: "Codex Done",
    }),
    env: {},
  });

  assert(normalized.title === "Done");
});

test("notification source normalizer recognizes Codex legacy notify argv payloads", () => {
  const normalized = normalizeIncomingNotification({
    argv: [
      "--shell-pid",
      "123",
      JSON.stringify({
        type: "agent-turn-complete",
        "thread-id": "thread-123",
        "turn-id": "turn-123",
        cwd: "D:\\XAGIT\\claude-code-tools",
        client: "codex-tui",
        "input-messages": ["Ping"],
        "last-assistant-message": "Pong",
      }),
    ],
    stdinData: "",
    env: {},
  });

  assert(normalized.sourceId === "codex-legacy-notify");
  assert(normalized.source === "Codex");
  assert(normalized.eventName === "Stop");
  assert(normalized.title === "Done");
  assert(normalized.message === "Task finished");
  assert(normalized.sessionId === "thread-123");
  assert(normalized.turnId === "turn-123");
  assert(normalized.projectDir === "D:\\XAGIT\\claude-code-tools");
});

test("notification source normalizer recognizes wrapper env payloads", () => {
  const normalized = normalizeIncomingNotification({
    argv: [],
    stdinData: "",
    env: {
      CLAUDE_CODE_NOTIFY_PAYLOAD: JSON.stringify({
        type: "agent-turn-complete",
        "thread-id": "thread-env-1",
        "turn-id": "turn-env-1",
        cwd: "D:\\XAGIT\\claude-code-tools",
        client: "codex-tui",
      }),
    },
  });

  assert(normalized.sourceId === "codex-legacy-notify");
  assert(normalized.transport === "env:CLAUDE_CODE_NOTIFY_PAYLOAD");
  assert(normalized.eventName === "Stop");
  assert(normalized.sessionId === "thread-env-1");
  assert(normalized.turnId === "turn-env-1");
});

test("notification source normalizer respects explicit source title and message", () => {
  const normalized = normalizeIncomingNotification({
    argv: [],
    stdinData: JSON.stringify({
      source: "BuildBot",
      title: "Queued",
      message: "Waiting in CI",
    }),
    env: {},
  });

  assert(normalized.source === "BuildBot");
  assert(normalized.title === "Queued");
  assert(normalized.message === "Waiting in CI");
});

test("cli.js resolves Windows codex shims before spawning", () => {
  assert(cliContent.includes("resolveCodexLaunch"));
  assert(cliContent.includes("where.exe"));
  assert(cliContent.includes('process.env.ComSpec || "cmd.exe"'));
  assert(cliContent.includes('".cmd"'));
});

test("notify.ps1 uses native toast + flash", () => {
  assert(notifyContent.includes("ToastNotificationManager"));
  assert(notifyContent.includes("FlashWindowEx"));
  assert(notifyContent.includes("activationType=`\"protocol`\""));
  assert(notifyContent.includes("Needs Approval"));
  assert(!notifyContent.includes("Needs Permission"));
  assert(notifyContent.includes("[$source] $baseTitle"));
});

test("cli.js passes neutral notify env vars to PowerShell", () => {
  assert(cliContent.includes("TOAST_NOTIFY_EVENT"));
  assert(cliContent.includes("TOAST_NOTIFY_SOURCE"));
  assert(cliContent.includes("TOAST_NOTIFY_TITLE"));
  assert(cliContent.includes("TOAST_NOTIFY_MESSAGE"));
  assert(cliContent.includes("TOAST_NOTIFY_LOG_FILE"));
  assert(!cliContent.includes("TOAST_NOTIFY_PROJECT_DIR"));
  assert(!cliContent.includes("CLAUDE_NOTIFY_PROJECT_DIR"));
  assert(!cliContent.includes("CLAUDE_PROJECT_DIR"));
});

test("postinstall registers protocol", () => {
  assert(postinstallContent.includes("register-protocol.ps1"));
});

test("postinstall installs the codex wrapper into LOCALAPPDATA", () => {
  assert(postinstallContent.includes("installCodexNotifyWrapper"));
  assert(postinstallContent.includes("codex-notify-wrapper.vbs"));
  assert(postinstallContent.includes("LOCALAPPDATA"));
});

test("start-hidden.vbs runs argv command hidden", () => {
  assert(startHiddenContent.includes("shell.Run command, 0, False"));
  assert(startHiddenContent.includes("WScript.Arguments.Count"));
  assert(startHiddenContent.includes("background watcher"));
});

test("codex wrapper forwards payload through env and then calls the installed shim", () => {
  assert(codexWrapperContent.includes("CLAUDE_CODE_NOTIFY_PAYLOAD"));
  assert(codexWrapperContent.includes("claude-code-notify.cmd"));
  assert(codexWrapperContent.includes('%ComSpec%'));
  assert(codexWrapperContent.includes("exitCode = 9009"));
  assert(codexWrapperContent.includes("npx.cmd @erica_s/claude-code-notify"));
  assert(codexWrapperContent.includes("shell.Run"));
});

test("watcher resets through console attachment plus standard streams", () => {
  assert(watcherContent.includes("Write-OscToInheritedStreams"));
  assert(watcherContent.includes("Write-OscToAttachedConsole"));
  assert(watcherContent.includes("AttachConsole"));
  assert(watcherContent.includes("[Console]::OpenStandardOutput()"));
  assert(watcherContent.includes("[Console]::OpenStandardError()"));
  assert(watcherContent.includes('"$ESC]104;264$ST"'));
  assert(!watcherContent.includes("SendKeys"));
});

test("README documents codex watcher usage", () => {
  const readmeContent = read("README.md");
  assert(readmeContent.includes("codex-watch"));
  assert(readmeContent.includes("waitingOnApproval"));
  assert(readmeContent.includes("Scoped / Advanced"));
  assert(readmeContent.includes("protocol debugging"));
});

test("README documents codex session watcher usage", () => {
  const readmeContent = read("README.md");
  assert(readmeContent.includes("codex-session-watch"));
  assert(readmeContent.includes("auto-start it in the background"));
  assert(readmeContent.includes("codex-tui.log"));
  assert(readmeContent.includes("approval reminders"));
  assert(readmeContent.includes("false positives"));
  assert(readmeContent.includes(DEV_DOCS_URL));
});

test("README documents direct Codex notify support and limitation", () => {
  const readmeContent = read("README.md");
  assert(readmeContent.includes("agent-turn-complete"));
  assert(readmeContent.includes('notify = ["claude-code-notify"]'));
  assert(readmeContent.includes("Use this in `~/.codex/config.toml`:"));
  assert(readmeContent.includes("Windows Terminal tab highlight"));
  assert(readmeContent.includes("15 days"));
  assert(readmeContent.includes("It cannot signal approval"));
  assert(!readmeContent.includes("CLAUDE_CODE_NOTIFY_PAYLOAD"));
});

test("README documents the codex mcp sidecar companion", () => {
  const readmeContent = read("README.md");
  assert(readmeContent.includes("Codex MCP Sidecar"));
  assert(readmeContent.includes("codex-mcp-sidecar"));
  assert(readmeContent.includes("hidden-launch `codex-session-watch`"));
  assert(readmeContent.includes("[mcp_servers.claude_code_notify_sidecar]"));
  assert(readmeContent.includes('command = "cmd.exe"'));
  assert(
    readmeContent.includes('args = ["/d", "/c", "claude-code-notify", "codex-mcp-sidecar"]')
  );
  assert(readmeContent.includes("Do **not** set `cwd`"));
  assert(readmeContent.includes("Toast-only behavior"));
});

test("README stays user-focused while development docs are split by topic", () => {
  const readmeContent = read("README.md");
  const developmentContent = read("docs/development.md");
  const architectureContent = read("docs/architecture.md");
  const approvalContent = read("docs/codex-approval.md");
  const windowsRuntimeContent = read("docs/windows-runtime.md");
  const historyContent = read("docs/history/codex-notify-findings.md");
  assert(!readmeContent.includes("Reminder + Localization Responsibilities"));
  assert(!readmeContent.includes("npm link"));
  assert(!readmeContent.includes("node postinstall.js"));
  assert(readmeContent.includes("For implementation details and design trade-offs"));
  assert(readmeContent.includes(DEV_DOCS_URL));
  assert(developmentContent.includes("README 只保留安装、配置、常用命令"));
  assert(developmentContent.includes("./architecture.md"));
  assert(developmentContent.includes("./codex-approval.md"));
  assert(developmentContent.includes("./windows-runtime.md"));
  assert(developmentContent.includes("./history/"));
  assert(!readmeContent.includes("codex-notify-wrapper.vbs"));
  assert(!developmentContent.includes("CLAUDE_CODE_NOTIFY_PAYLOAD"));
  assert(architectureContent.includes("提醒 + 定位的职责拆分"));
  assert(architectureContent.includes("通道能力矩阵"));
  assert(architectureContent.includes("当前项目里的真实数据流"));
  assert(architectureContent.includes("completion 不走 sidecar 这条链"));
  assert(architectureContent.includes("tui.notification_method"));
  assert(approvalContent.includes("为什么不把 approval 定位完全交给 MCP server"));
  assert(approvalContent.includes("已批准命令 / 快速完成命令的误报"));
  assert(approvalContent.includes("1 秒 grace 窗口"));
  assert(approvalContent.includes("default.rules"));
  assert(windowsRuntimeContent.includes("CLAUDE_CODE_NOTIFY_PAYLOAD"));
  assert(windowsRuntimeContent.includes("Tab 级定位"));
  assert(historyContent.includes("os error 206"));
  assert(historyContent.includes("第二条线当前仍不能删"));
});

test("README and development docs only use valid local markdown links", () => {
  [
    "README.md",
    "docs/development.md",
    "docs/architecture.md",
    "docs/codex-approval.md",
    "docs/windows-runtime.md",
    "docs/history/README.md",
  ].forEach(assertLocalMarkdownLinksExist);
});

console.log("\n--- Smoke ---");

if (!canSpawnChildren) {
  skip("postinstall.js passes node syntax check", "sandbox blocks nested child_process execution");
  if (process.platform === "win32") {
    skip("tab-color-watcher.ps1 parses as a script block", "sandbox blocks nested child_process execution");
    skip("cli.js exits cleanly for Stop", "sandbox blocks nested child_process execution");
    skip("cli.js exits cleanly for PermissionRequest", "sandbox blocks nested child_process execution");
    skip("cli.js exits cleanly for default", "sandbox blocks nested child_process execution");
  }
} else {
  test("postinstall.js passes node syntax check", () => {
    execFileSync("node", ["--check", path.join(ROOT, "postinstall.js")], { stdio: "pipe" });
  });

  if (process.platform === "win32") {
    test("tab-color-watcher.ps1 parses as a script block", () => {
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "[void][scriptblock]::Create((Get-Content '" +
            path.join(ROOT, "scripts", "tab-color-watcher.ps1").replace(/'/g, "''") +
            "' -Raw))",
        ],
        { stdio: "pipe" }
      );
    });

    ["Stop", "PermissionRequest", ""].forEach((eventName) => {
      const label = eventName || "default";
      test(`cli.js exits cleanly for ${label}`, () => {
        const input = eventName
          ? JSON.stringify({ hook_event_name: eventName, session_id: `test-${label}` })
          : "";
        execFileSync("node", [path.join(ROOT, "bin", "cli.js")], {
          input,
          timeout: 15000,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      });
    });

    test("cli.js exits cleanly for Codex legacy notify argv payload", () => {
      execFileSync(
        "node",
        [
          path.join(ROOT, "bin", "cli.js"),
          JSON.stringify({
            type: "agent-turn-complete",
            "thread-id": "thread-smoke-1",
            "turn-id": "turn-smoke-1",
            cwd: "D:\\XAGIT\\claude-code-tools",
            client: "codex-tui",
            "input-messages": ["Ping"],
            "last-assistant-message": "Pong",
          }),
        ],
        {
          timeout: 15000,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
    });

    test("cli.js prints help for codex-session-watch", () => {
      const output = execFileSync("node", [path.join(ROOT, "bin", "cli.js"), "codex-session-watch", "--help"], {
        timeout: 15000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      assert(output.includes("codex-session-watch"));
      assert(output.includes("--sessions-dir"));
      assert(output.includes("--tui-log"));
    });

  } else {
    console.log("  SKIP  Windows-only smoke checks");
  }
}

console.log(`\n--- Results: ${passed} passed, ${failed} failed, ${skipped} skipped ---\n`);
process.exit(failed > 0 ? 1 : 0);
