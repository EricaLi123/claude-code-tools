module.exports = function runSidecarTests(h) {
  const {
    assert,
    fs,
    mcpServer,
    path,
    ROOT,
    section,
    sessionWatchNotify,
    sidecarResolver,
    sidecarState,
    test,
    TEST_PROJECT_DIR,
  } = h;

  section("Sidecar");

  test("sidecar candidate picker prefers the closest unambiguous rollout", () => {
    const candidate = sidecarResolver.pickSidecarSessionCandidate([
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
    const candidate = sidecarResolver.pickSidecarSessionCandidate([
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
    const candidate = sidecarResolver.pickSidecarSessionCandidate([
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

      const candidate = sidecarResolver.resolveSidecarSessionCandidate({
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

  test("watcher reconcile turns raw sidecar observations into exact session mappings", () => {
    const fixtureRoot = path.join(ROOT, `.tmp-sidecar-reconcile-${Date.now()}`);
    const sessionsDir = path.join(fixtureRoot, "2026", "04", "04");
    const sessionId = `session-reconcile-${Date.now()}`;
    const rolloutPath = path.join(
      sessionsDir,
      `rollout-2026-04-04T15-00-00-${sessionId}.jsonl`
    );
    const recordId = `test-sidecar-reconcile-${process.pid}-${Date.now()}`;
    const startedAt = new Date().toISOString();

    try {
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(
        rolloutPath,
        [
          JSON.stringify({
            timestamp: startedAt,
            type: "session_meta",
            payload: {
              id: sessionId,
              cwd: TEST_PROJECT_DIR,
            },
          }),
          JSON.stringify({
            timestamp: startedAt,
            type: "turn_context",
            payload: {
              cwd: TEST_PROJECT_DIR,
            },
          }),
        ].join("\n"),
        "utf8"
      );

      sidecarState.writeSidecarRecord({
        recordId,
        pid: 999999,
        parentPid: process.ppid,
        cwd: TEST_PROJECT_DIR,
        sessionId: "",
        startedAt,
        resolvedAt: "",
        hwnd: 3456,
        shellPid: 7890,
        isWindowsTerminal: true,
      });

      const reconciled = sidecarState.reconcileSidecarSessions({
        sessionsDir: fixtureRoot,
        targetSessionId: sessionId,
        projectDir: TEST_PROJECT_DIR,
        log: () => {},
      });

      assert(reconciled === 1, "expected watcher reconcile to resolve one observation");

      const terminal = sidecarState.findSidecarTerminalContextForSession(sessionId);
      assert(terminal);
      assert(terminal.sessionId === sessionId);
      assert(terminal.hwnd === 3456);
      assert(terminal.shellPid === 7890);
      assert(terminal.isWindowsTerminal === true);
    } finally {
      sidecarState.deleteSidecarRecord(recordId);
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
      mcpServer.handleMcpServerMessage({ id: "req-1", method: "ping" }, () => {});
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
        cwd: TEST_PROJECT_DIR,
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
        cwd: TEST_PROJECT_DIR,
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

  test("sidecar prune deletes stale unresolved records based on stored timestamps", () => {
    const recordId = `test-sidecar-stale-unresolved-${process.pid}-${Date.now()}`;
    const recordPath = path.join(sidecarState.getSidecarStateDir(), `${recordId}.json`);
    const oldIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    try {
      sidecarState.writeSidecarRecord({
        recordId,
        pid: 999999,
        parentPid: process.ppid,
        cwd: TEST_PROJECT_DIR,
        sessionId: "",
        startedAt: oldIso,
        resolvedAt: "",
        hwnd: 5432,
        shellPid: 6543,
        isWindowsTerminal: true,
      });

      const persisted = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      persisted.startedAt = oldIso;
      persisted.updatedAt = oldIso;
      persisted.resolvedAt = "";
      persisted.lastMatchedAt = "";
      fs.writeFileSync(recordPath, JSON.stringify(persisted, null, 2), "utf8");

      sidecarState.pruneStaleSidecarRecords();

      assert(!fs.existsSync(recordPath), "expected stale unresolved record to be deleted");
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
        cwd: TEST_PROJECT_DIR,
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
        cwd: TEST_PROJECT_DIR,
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

  test("session watcher terminal resolution falls back to project-dir hwnd when no exact session mapping exists", () => {
    const recordId = `test-sidecar-project-${process.pid}-${Date.now()}`;
    const projectDir = path.join(ROOT, `.tmp-sidecar-project-${Date.now()}`);
    const recordCwd = path.join(projectDir, "subdir");
    const logs = [];

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

      const terminal = sessionWatchNotify.resolveSessionWatchTerminalContext({
        sessionId: `missing-session-${Date.now()}`,
        projectDir,
        fallbackTerminal: {
          hwnd: null,
          shellPid: null,
          isWindowsTerminal: false,
        },
        log: (message) => logs.push(message),
      });

      assert(terminal);
      assert(terminal.hwnd === 2468);
      assert(terminal.shellPid === null);
      assert(terminal.isWindowsTerminal === false);
      assert(
        logs.some((message) =>
          message.includes("session-watch terminal exact sidecar match missed")
        )
      );
      assert(
        logs.some((message) =>
          message.includes("sidecar project-dir fallback matched")
        )
      );
      assert(
        logs.some((message) =>
          message.includes("session-watch terminal resolved via project-dir fallback")
        )
      );
    } finally {
      sidecarState.deleteSidecarRecord(recordId);
    }
  });

  test("session watcher terminal resolution lets watcher reconcile raw observations into exact matches", () => {
    const fixtureRoot = path.join(ROOT, `.tmp-sidecar-watch-reconcile-${Date.now()}`);
    const sessionsDir = path.join(fixtureRoot, "2026", "04", "04");
    const sessionId = `session-watch-reconcile-${Date.now()}`;
    const rolloutPath = path.join(
      sessionsDir,
      `rollout-2026-04-04T16-00-00-${sessionId}.jsonl`
    );
    const recordId = `test-sidecar-watch-reconcile-${process.pid}-${Date.now()}`;
    const startedAt = new Date().toISOString();
    const logs = [];

    try {
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(
        rolloutPath,
        [
          JSON.stringify({
            timestamp: startedAt,
            type: "session_meta",
            payload: {
              id: sessionId,
              cwd: TEST_PROJECT_DIR,
            },
          }),
          JSON.stringify({
            timestamp: startedAt,
            type: "turn_context",
            payload: {
              cwd: TEST_PROJECT_DIR,
            },
          }),
        ].join("\n"),
        "utf8"
      );

      sidecarState.writeSidecarRecord({
        recordId,
        pid: 999999,
        parentPid: process.ppid,
        cwd: TEST_PROJECT_DIR,
        sessionId: "",
        startedAt,
        resolvedAt: "",
        hwnd: 9753,
        shellPid: 8642,
        isWindowsTerminal: true,
      });

      const terminal = sessionWatchNotify.resolveSessionWatchTerminalContext({
        sessionId,
        projectDir: TEST_PROJECT_DIR,
        fallbackTerminal: {
          hwnd: null,
          shellPid: null,
          isWindowsTerminal: false,
        },
        log: (message) => logs.push(message),
        sessionsDir: fixtureRoot,
      });

      assert(terminal);
      assert(terminal.hwnd === 9753);
      assert(terminal.shellPid === 8642);
      assert(terminal.isWindowsTerminal === true);
      assert(
        logs.some((message) =>
          message.includes("watcher reconciled sidecar observation")
        )
      );
      assert(
        logs.some((message) =>
          message.includes("session-watch terminal reconcile retried")
        )
      );
      assert(
        logs.some((message) =>
          message.includes("session-watch terminal resolved via exact sidecar match")
        )
      );
    } finally {
      sidecarState.deleteSidecarRecord(recordId);
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
};
