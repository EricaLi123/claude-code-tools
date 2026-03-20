#!/usr/bin/env node

// Lightweight tests for claude-code-notify
// Run: node test/test-cli.js

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const cli = require(path.join(ROOT, "bin", "cli.js"));
const { normalizeIncomingNotification } = require(path.join(ROOT, "lib", "notification-sources.js"));

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
  "lib/notification-sources.js",
  "postinstall.js",
  "scripts/find-hwnd.ps1",
  "scripts/get-shell-pid.ps1",
  "scripts/notify.ps1",
  "scripts/register-protocol.ps1",
  "scripts/start-tab-color-watcher.ps1",
  "scripts/tab-color-watcher.ps1",
].forEach((relPath) => {
  test(`${relPath} exists`, () => {
    assert(fs.existsSync(path.join(ROOT, relPath)), `${relPath} missing`);
  });
});

console.log("\n--- package.json ---");

const pkg = JSON.parse(read("package.json"));

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
const postinstallContent = read("postinstall.js");
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
});

test("session watcher recognizes response_item function_call approvals early", () => {
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
      sessionWritableRoots: new Map(),
    }
  );

  assert(event);
  assert(event.eventType === "require_escalated_tool_call");
  assert(event.dedupeKey === "session-3|exec|turn-3|shell_command:Get-Date");
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
  assert(readmeContent.includes("thread/status/changed"));
});

test("README documents codex session watcher usage", () => {
  const readmeContent = read("README.md");
  assert(readmeContent.includes("codex-session-watch"));
  assert(readmeContent.includes("response_item"));
  assert(readmeContent.includes("codex-tui.log"));
  assert(readmeContent.includes("sandbox_permissions"));
  assert(readmeContent.includes("apply_patch_approval_request"));
  assert(readmeContent.includes("does not infer approval from `ToolCall: apply_patch`"));
});

test("README documents direct Codex notify support and limitation", () => {
  const readmeContent = read("README.md");
  assert(readmeContent.includes("agent-turn-complete"));
  assert(readmeContent.includes("notify = [\"claude-code-notify\"]"));
  assert(readmeContent.includes("cannot signal approval requests"));
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
