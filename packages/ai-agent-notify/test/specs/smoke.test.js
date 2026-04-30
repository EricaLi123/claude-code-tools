module.exports = function runSmokeTests(h) {
  const {
    assert,
    canSpawnChildren,
    execFileSync,
    NODE_EXECUTABLE,
    path,
    ROOT,
    section,
    skip,
    test,
    TEST_PROJECT_DIR,
  } = h;

  section("Smoke");

  if (!canSpawnChildren) {
    if (process.platform === "win32") {
      skip(
        "tab-color-watcher.ps1 parses as a script block",
        "sandbox blocks nested child_process execution"
      );
      skip("cli.js exits cleanly for Stop", "sandbox blocks nested child_process execution");
      skip(
        "cli.js exits cleanly for PermissionRequest",
        "sandbox blocks nested child_process execution"
      );
      skip("cli.js exits cleanly for default", "sandbox blocks nested child_process execution");
    }
    return;
  }

  if (process.platform !== "win32") {
    console.log("  SKIP  Windows-only smoke checks");
    return;
  }

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
      execFileSync(NODE_EXECUTABLE, [path.join(ROOT, "bin", "cli.js")], {
        input,
        timeout: 15000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    });
  });

  test("cli.js exits cleanly for Codex legacy notify argv payload", () => {
    execFileSync(
      NODE_EXECUTABLE,
      [
        path.join(ROOT, "bin", "cli.js"),
        JSON.stringify({
          type: "agent-turn-complete",
          "thread-id": "thread-smoke-1",
          "turn-id": "turn-smoke-1",
          cwd: TEST_PROJECT_DIR,
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
    const output = execFileSync(
      NODE_EXECUTABLE,
      [path.join(ROOT, "bin", "cli.js"), "codex-session-watch", "--help"],
      {
        timeout: 15000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert(output.includes("codex-session-watch"));
    assert(output.includes("--sessions-dir"));
    assert(output.includes("--tui-log"));
  });

  test("runDefaultNotifyMode dispatches direct notifications in the current process", () => {
    const output = execFileSync(
      NODE_EXECUTABLE,
      [
        "-e",
        `
const cli = require(${JSON.stringify(path.join(ROOT, "bin", "cli.js"))});
async function runCase(entryPointId, argv) {
  let detectCalled = false;
  let emitArgs = null;
  let exitCode = null;
  const callbacks = {};
  const child = {
    on: (name, cb) => {
      callbacks[name] = cb;
      return child;
    }
  };
  const result = await cli.runDefaultNotifyMode(argv, {
    stdinData: "{}",
    normalizeIncomingNotificationImpl: () => ({
      agentId: "codex",
      entryPointId,
      sessionId: "single-process-session",
      turnId: "single-process-turn",
      eventName: entryPointId === "hooks-mode" ? "PermissionRequest" : "Stop",
      title: entryPointId === "hooks-mode" ? "Needs Approval" : "Done",
      message: entryPointId === "hooks-mode" ? "Waiting for your approval" : "Task finished",
      rawEventType: entryPointId === "hooks-mode" ? "PermissionRequest" : "Stop",
      transport: "stdin",
      debugSummary: "test payload"
    }),
    createRuntimeImpl: () => ({
      isDev: true,
      logFile: "NUL",
      logStem: "single-process-test",
      buildInfo: { packageRoot: "D:\\\\git\\\\ai-tools\\\\packages\\\\ai-agent-notify" },
      log: () => {}
    }),
    detectTerminalContextImpl: () => {
      detectCalled = true;
      return { hwnd: 987, shellPid: 654, isWindowsTerminal: true };
    },
    emitNotificationImpl: (args) => {
      emitArgs = args;
      setImmediate(() => {
        if (callbacks.close) {
          callbacks.close(0);
        }
      });
      return child;
    },
    exitProcessImpl: (code) => {
      exitCode = code;
    }
  });

  await new Promise((resolve) => setImmediate(resolve));

  return {
    detectCalled,
    emitCalled: Boolean(emitArgs),
    exitCode,
    resultHasOn: Boolean(result && typeof result.on === "function"),
    terminal: emitArgs ? emitArgs.terminal : null,
    entryPointId: emitArgs ? emitArgs.entryPointId : "",
    eventName: emitArgs ? emitArgs.eventName : ""
  };
}

Promise.all([
  runCase("hooks-mode", []),
  runCase("notify-mode", ["--shell-pid", "4321"])
]).then((results) => {
  process.stdout.write(JSON.stringify(results));
}).catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
        `,
      ],
      {
        timeout: 15000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    const [hooksCase, notifyCase] = JSON.parse(output);
    assert(hooksCase.detectCalled === true, "hooks-mode should detect terminal context");
    assert(hooksCase.emitCalled === true, "hooks-mode should dispatch notification in-process");
    assert(hooksCase.exitCode === 0, "hooks-mode should exit cleanly after child close");
    assert(hooksCase.resultHasOn === true, "hooks-mode should return the spawned child handle");
    assert(hooksCase.entryPointId === "hooks-mode", "hooks-mode should preserve the entry point");
    assert(hooksCase.eventName === "PermissionRequest", "hooks-mode should preserve the event");
    assert(hooksCase.terminal && hooksCase.terminal.hwnd === 987, "hooks-mode should forward hwnd");
    assert(
      hooksCase.terminal && hooksCase.terminal.shellPid === 654,
      "hooks-mode should forward shell pid"
    );
    assert(
      hooksCase.terminal && hooksCase.terminal.isWindowsTerminal === true,
      "hooks-mode should forward WT terminal hints"
    );

    assert(notifyCase.detectCalled === true, "notify-mode should detect terminal context");
    assert(notifyCase.emitCalled === true, "notify-mode should dispatch notification in-process");
    assert(notifyCase.exitCode === 0, "notify-mode should exit cleanly after child close");
    assert(notifyCase.resultHasOn === true, "notify-mode should return the spawned child handle");
    assert(notifyCase.entryPointId === "notify-mode", "notify-mode should preserve the entry point");
    assert(notifyCase.eventName === "Stop", "notify-mode should preserve the event");
    assert(notifyCase.terminal && notifyCase.terminal.hwnd === 987, "notify-mode should forward hwnd");
    assert(
      notifyCase.terminal && notifyCase.terminal.shellPid === 654,
      "notify-mode should forward detected shell pid instead of raw flags"
    );
    assert(
      notifyCase.terminal && notifyCase.terminal.isWindowsTerminal === true,
      "notify-mode should forward WT terminal hints"
    );
  });
};
