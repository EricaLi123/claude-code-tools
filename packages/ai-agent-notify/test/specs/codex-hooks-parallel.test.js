module.exports = function runCodexHooksParallelTests(h) {
  const {
    assert,
    fs,
    notifyRuntime,
    path,
    ROOT,
    section,
    test,
  } = h;

  section("Codex hooks parallel");

  function loadCli() {
    return require(path.join(ROOT, "bin", "cli.js"));
  }

  function loadApprovalNotify() {
    return require(path.join(ROOT, "lib", "codex-approval-notify.js"));
  }

  function loadCompletionNotify() {
    return require(path.join(ROOT, "lib", "codex-completion-notify.js"));
  }

  function loadCompletionReceipts() {
    return require(path.join(ROOT, "lib", "codex-completion-receipts.js"));
  }

  function loadEventReconciliation() {
    return require(path.join(ROOT, "lib", "codex-event-reconciliation.js"));
  }

  test("completion receipt writer accepts Codex hooks Stop payloads", () => {
    const completionReceipts = loadCompletionReceipts();
    const sessionId = `codex-hooks-receipt-session-${process.pid}-${Date.now()}`;
    const turnId = `codex-hooks-receipt-turn-${process.hrtime.bigint().toString()}`;
    const key = completionReceipts.buildCodexCompletionReceiptKey({
      sessionId,
      turnId,
      eventName: "Stop",
    });
    const receiptPath = path.join(
      notifyRuntime.LOG_DIR,
      "completion-receipts",
      `${require("crypto").createHash("sha1").update(key).digest("hex")}.json`
    );

    try {
      const wrote = completionReceipts.writeCodexCompletionReceiptForNotification({
        agentId: "codex",
        entryPointId: "hooks-mode",
        eventName: "Stop",
        sessionId,
        turnId,
      });

      assert(wrote === true, "expected hooks Stop payload to write a completion receipt");
      assert(fs.existsSync(receiptPath), "expected hooks Stop receipt file to exist");
    } finally {
      try {
        fs.unlinkSync(receiptPath);
      } catch {}
    }
  });

  test("parallel reconciliation emits once and records both hooks and watcher paths", () => {
    const eventReconciliation = loadEventReconciliation();
    const tempRoot = path.join(ROOT, `.tmp-codex-hooks-reconcile-${Date.now()}`);
    const runtime = { log: () => {} };
    const hooksNotification = {
      agentId: "codex",
      entryPointId: "hooks-mode",
      sessionId: "parallel-session-1",
      turnId: "parallel-turn-1",
      eventName: "PermissionRequest",
      projectDir: "D:\\repo\\sample-project",
    };
    const watcherNotification = {
      agentId: "codex",
      entryPointId: "rollout-watch",
      sessionId: "parallel-session-1",
      turnId: "parallel-turn-1",
      eventName: "PermissionRequest",
      projectDir: "D:\\repo\\sample-project",
    };

    try {
      const first = eventReconciliation.shouldEmitCodexEventNotification(hooksNotification, {
        runtime,
        reconciliationsDir: tempRoot,
        nowMs: 1_000,
      });
      const second = eventReconciliation.shouldEmitCodexEventNotification(watcherNotification, {
        runtime,
        reconciliationsDir: tempRoot,
        nowMs: 1_100,
      });

      assert(first === true, "first parallel path should emit");
      assert(second === false, "second parallel path should reconcile instead of emitting");

      const recordFiles = fs.readdirSync(tempRoot).filter((entry) => entry.endsWith(".json"));
      assert(recordFiles.length === 1, "expected one reconciliation record file");

      const record = JSON.parse(fs.readFileSync(path.join(tempRoot, recordFiles[0]), "utf8"));
      assert(
        record.key === "parallel-session-1|parallel-turn-1|PermissionRequest",
        "reconciliation key mismatch"
      );
      assert(record.paths["codex|hooks-mode"], "missing hooks path record");
      assert(record.paths["codex|rollout-watch"], "missing watcher path record");
    } finally {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {}
    }
  });

  test("default notify mode skips dispatch when parallel reconciliation already matched", () => {
    const cli = loadCli();
    let detectCalled = false;
    let emitCalled = false;
    let exitCode = null;

    cli.runDefaultNotifyMode([], {
      stdinData: "",
      normalizeIncomingNotificationImpl: () => ({
        agentId: "codex",
        entryPointId: "hooks-mode",
        transport: "stdin",
        sessionId: "parallel-session-2",
        turnId: "parallel-turn-2",
        eventName: "Stop",
        title: "Done",
        message: "Task finished",
        rawEventType: "Stop",
        debugSummary: "parallel hooks duplicate",
      }),
      createRuntimeImpl: () => ({
        buildInfo: { packageRoot: ROOT },
        isDev: true,
        logFile: path.join(notifyRuntime.LOG_DIR, `hooks-parallel-${Date.now()}.log`),
        logStem: `hooks-parallel-${Date.now()}`,
        log: () => {},
      }),
      shouldEmitCodexEventNotificationImpl: () => false,
      detectTerminalContextImpl: () => {
        detectCalled = true;
        return { hwnd: null, shellPid: null, isWindowsTerminal: false };
      },
      emitNotificationImpl: () => {
        emitCalled = true;
        return { on: () => {} };
      },
      exitProcessImpl: (code) => {
        exitCode = code;
      },
      writeCodexCompletionReceiptForNotificationImpl: () => true,
    });

    assert(!detectCalled, "parallel duplicate should skip terminal detection");
    assert(!emitCalled, "parallel duplicate should skip notification dispatch");
    assert(exitCode === 0, "parallel duplicate should exit cleanly");
  });

  test("approval notify skips duplicate emit when parallel reconciliation already matched", () => {
    const approvalNotify = loadApprovalNotify();
    let emitCalled = false;

    const emitted = approvalNotify.emitCodexApprovalNotification({
      event: {
        agentId: "codex",
        entryPointId: "rollout-watch",
        eventName: "PermissionRequest",
        eventType: "exec_approval_request",
        title: "Needs Approval",
        message: "Waiting for your approval",
        sessionId: "parallel-session-3",
        turnId: "parallel-turn-3",
        projectDir: "D:\\repo\\sample-project",
        dedupeKey: "parallel-session-3|parallel-turn-3|PermissionRequest",
      },
      runtime: { log: () => {} },
      terminal: { hwnd: null, shellPid: null, isWindowsTerminal: false },
      emittedEventKeys: new Map(),
      origin: "test",
      sessionsDir: ROOT,
      shouldEmitCodexEventNotificationImpl: () => false,
      emitNotificationImpl: () => {
        emitCalled = true;
        return { on: () => {} };
      },
    });

    assert(emitted === false, "parallel duplicate approval should not emit");
    assert(!emitCalled, "parallel duplicate approval should skip notify runtime");
  });

  test("completion notify skips duplicate emit when parallel reconciliation already matched", () => {
    const completionNotify = loadCompletionNotify();
    let emitCalled = false;

    const emitted = completionNotify.emitPreparedCodexCompletionNotification({
      prepared: {
        event: {
          agentId: "codex",
          entryPointId: "rollout-watch",
          eventName: "Stop",
          eventType: "task_complete",
          title: "Done",
          message: "Task finished",
          sessionId: "parallel-session-4",
          turnId: "parallel-turn-4",
          projectDir: "D:\\repo\\sample-project",
          dedupeKey: "parallel-session-4|parallel-turn-4|Stop",
        },
        notificationTerminal: { hwnd: null, shellPid: null, isWindowsTerminal: false },
      },
      runtime: { log: () => {} },
      emittedEventKeys: new Map(),
      origin: "test",
      terminal: { hwnd: null, shellPid: null, isWindowsTerminal: false },
      sessionsDir: ROOT,
      shouldEmitCodexEventNotificationImpl: () => false,
      emitNotificationImpl: () => {
        emitCalled = true;
        return { on: () => {} };
      },
    });

    assert(emitted === false, "parallel duplicate completion should not emit");
    assert(!emitCalled, "parallel duplicate completion should skip notify runtime");
  });
};
