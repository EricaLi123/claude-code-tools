module.exports = function runSessionStartTests(h) {
  const {
    assert,
    findCodexSessionStartPayload,
    fs,
    path,
    ROOT,
    section,
    sessionStartHook,
    sessionWatchNotify,
    terminalContextStore,
    test,
    TEST_PROJECT_DIR,
  } = h;

  section("SessionStart");

  test("SessionStart payload parser recognizes official Codex hook input", () => {
    const payload = findCodexSessionStartPayload({
      argv: [],
      stdinData: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "session-start-1",
        cwd: TEST_PROJECT_DIR,
        transcript_path: "C:\\Users\\ericali\\.codex\\history\\session.jsonl",
        model: "gpt-5.5",
        source: "startup",
      }),
      env: {},
    });

    assert(payload);
    assert(payload.sessionId === "session-start-1");
    assert(JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(["sessionId"]));
  });

  test("SessionStart hook ensures watcher and persists exact terminal context", () => {
    const sessionId = `session-start-hook-${Date.now()}`;
    const logs = [];
    let watcherCall = null;

    try {
      const result = sessionStartHook.runCodexSessionStartHook({
        argv: [],
        cliPath: "D:\\git\\ai-tools\\packages\\ai-agent-notify\\bin\\cli.js",
        payload: {
          sessionId,
        },
        createRuntimeImpl: () => ({
          buildInfo: { packageRoot: ROOT },
          log: (message) => logs.push(message),
        }),
        detectTerminalContextImpl: () => ({
          hwnd: 1234,
          shellPid: 5678,
          isWindowsTerminal: true,
        }),
        ensureCodexSessionWatchRunningImpl: (args) => {
          watcherCall = args;
          return { launched: true, pid: 9999 };
        },
      });

      assert(result.handled === true);
      assert(watcherCall);
      assert(watcherCall.cliPath.includes("cli.js"));
      const terminal = terminalContextStore.findTerminalContextForSession(sessionId);
      assert(terminal);
      assert(terminal.sessionId === sessionId);
      assert(terminal.hwnd === 1234);
      assert(terminal.shellPid === 5678);
      assert(terminal.isWindowsTerminal === true);
      assert(logs.some((message) => message.includes("stored session terminal context")));
    } finally {
      terminalContextStore.deleteTerminalContextRecord(sessionId);
    }
  });

  test("SessionStart hook skips persistence when terminal context is unavailable", () => {
    const sessionId = `session-start-empty-${Date.now()}`;
    let writeCalls = 0;

    const result = sessionStartHook.runCodexSessionStartHook({
      argv: [],
      cliPath: "D:\\git\\ai-tools\\packages\\ai-agent-notify\\bin\\cli.js",
      payload: {
        sessionId,
      },
      createRuntimeImpl: () => ({
        buildInfo: { packageRoot: ROOT },
        log: () => {},
      }),
      detectTerminalContextImpl: () => ({
        hwnd: null,
        shellPid: null,
        isWindowsTerminal: false,
      }),
      ensureCodexSessionWatchRunningImpl: () => ({ launched: false }),
      writeTerminalContextRecordImpl: () => {
        writeCalls += 1;
        return null;
      },
    });

    assert(result.handled === true);
    assert(result.record === null);
    assert(writeCalls === 0, "empty terminal context should not be persisted");
    assert(terminalContextStore.findTerminalContextForSession(sessionId) === null);
  });

  test("terminal context store keeps only minimal persisted fields", () => {
    const sessionId = `session-start-minimal-${Date.now()}`;
    const recordPath = path.join(
      terminalContextStore.getTerminalContextStateDir(),
      `${sessionId}.json`
    );

    try {
      terminalContextStore.writeTerminalContextRecord({
        sessionId,
        hwnd: 4321,
        shellPid: 8765,
        isWindowsTerminal: true,
        cwd: TEST_PROJECT_DIR,
        source: "startup",
        resolvedAt: new Date().toISOString(),
      });

      const persisted = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      assert(JSON.stringify(Object.keys(persisted).sort()) === JSON.stringify([
        "createdAt",
        "hwnd",
        "isWindowsTerminal",
        "kind",
        "lastMatchedAt",
        "sessionId",
        "shellPid",
        "updatedAt",
      ]));
      assert(persisted.kind === "codex-session-start");
      assert(!("cwd" in persisted));
      assert(!("resolvedAt" in persisted));
      assert(!("source" in persisted));
    } finally {
      terminalContextStore.deleteTerminalContextRecord(sessionId);
    }
  });

  test("session watcher resolves exact session matches from terminal context store", () => {
    const sessionId = `session-watch-hit-${Date.now()}`;
    const logs = [];

    try {
      terminalContextStore.writeTerminalContextRecord({
        sessionId,
        hwnd: 9753,
        shellPid: 8642,
        isWindowsTerminal: true,
      });

      const terminal = sessionWatchNotify.resolveSessionWatchTerminalContext({
        sessionId,
        fallbackTerminal: {
          hwnd: null,
          shellPid: null,
          isWindowsTerminal: false,
        },
        log: (message) => logs.push(message),
      });

      assert(terminal);
      assert(terminal.hwnd === 9753);
      assert(terminal.shellPid === 8642);
      assert(terminal.isWindowsTerminal === true);
      assert(
        logs.some((message) =>
          message.includes("session-watch terminal resolved via exact session match")
        )
      );
    } finally {
      terminalContextStore.deleteTerminalContextRecord(sessionId);
    }
  });

  test("session watcher falls back to neutral terminal when no exact session mapping exists", () => {
    const logs = [];
    const terminal = sessionWatchNotify.resolveSessionWatchTerminalContext({
      sessionId: `missing-session-${Date.now()}`,
      fallbackTerminal: {
        hwnd: null,
        shellPid: null,
        isWindowsTerminal: false,
      },
      log: (message) => logs.push(message),
    });

    assert(terminal);
    assert(terminal.hwnd === null);
    assert(terminal.shellPid === null);
    assert(terminal.isWindowsTerminal === false);
    assert(
      logs.some((message) =>
        message.includes("session-watch terminal exact session match missed")
      )
    );
    assert(!logs.some((message) => message.includes("project-dir fallback")));
    assert(!logs.some((message) => message.includes("reconcile")));
  });

  test("terminal context prune deletes stale records based on stored timestamps", () => {
    const sessionId = `session-start-stale-${Date.now()}`;
    const recordPath = path.join(
      terminalContextStore.getTerminalContextStateDir(),
      `${sessionId}.json`
    );
    const oldIso = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    try {
      terminalContextStore.writeTerminalContextRecord({
        sessionId,
        hwnd: 5432,
        shellPid: 6543,
        isWindowsTerminal: true,
      });

      const persisted = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      persisted.createdAt = oldIso;
      persisted.updatedAt = oldIso;
      persisted.lastMatchedAt = "";
      fs.writeFileSync(recordPath, JSON.stringify(persisted, null, 2), "utf8");

      terminalContextStore.pruneStaleTerminalContextRecords();

      assert(!fs.existsSync(recordPath), "expected stale session record to be deleted");
    } finally {
      terminalContextStore.deleteTerminalContextRecord(sessionId);
    }
  });

  test("exact session lookups refresh persisted record freshness", () => {
    const sessionId = `session-start-refresh-${Date.now()}`;
    const recordPath = path.join(
      terminalContextStore.getTerminalContextStateDir(),
      `${sessionId}.json`
    );
    const oldIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    try {
      terminalContextStore.writeTerminalContextRecord({
        sessionId,
        hwnd: 7654,
        shellPid: 8765,
        isWindowsTerminal: true,
      });

      const persisted = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      persisted.createdAt = oldIso;
      persisted.updatedAt = oldIso;
      persisted.lastMatchedAt = "";
      fs.writeFileSync(recordPath, JSON.stringify(persisted, null, 2), "utf8");

      const terminal = terminalContextStore.findTerminalContextForSession(sessionId);
      assert(terminal, "expected exact session lookup to succeed");

      const refreshed = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      assert(Date.parse(refreshed.updatedAt) > Date.parse(oldIso));
      assert(Date.parse(refreshed.lastMatchedAt) > Date.parse(oldIso));
    } finally {
      terminalContextStore.deleteTerminalContextRecord(sessionId);
    }
  });
};
