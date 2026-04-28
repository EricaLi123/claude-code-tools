module.exports = function runStructureAndRuntimeTests(h) {
  const {
    assert,
    fs,
    normalizeTestPath,
    notifyRuntime,
    path,
    read,
    ROOT,
    section,
    sessionWatchRunner,
    test,
    windowsPaths,
  } = h;

  section("File structure");

  [
    "bin/cli.js",
    "lib/codex-mcp-sidecar-mode.js",
    "lib/codex-mcp-server.js",
    "lib/codex-sidecar-matcher.js",
    "lib/codex-sidecar-resolver.js",
    "lib/codex-sidecar-store.js",
    "lib/codex-session-event-descriptors.js",
    "lib/codex-session-rollout-events.js",
    "lib/codex-session-tui-events.js",
    "lib/codex-session-watch-files.js",
    "lib/codex-session-watch-handlers.js",
    "lib/codex-session-watch-notify.js",
    "lib/codex-session-watch-runner.js",
    "lib/codex-session-watch-streams.js",
    "lib/notification-source-display.js",
    "lib/notification-source-parsers.js",
    "lib/notify-terminal-context.js",
    "lib/notify-runtime.js",
    "lib/shared-utils.js",
    "lib/windows-paths.js",
    "scripts/find-hwnd.ps1",
    "scripts/get-shell-pid.ps1",
    "scripts/manual/test-toast.ps1",
    "scripts/notify.ps1",
    "scripts/start-hidden.vbs",
    "scripts/start-tab-color-watcher.ps1",
    "scripts/tab-color-watcher.ps1",
    "mock-codex-permission/README.md",
    "mock-codex-permission/target.txt",
    "mock-codex-permission/.codex/config.toml",
    "docs/README.md",
    "docs/principles.md",
    "docs/architecture.md",
    "docs/codex-approval.md",
    "docs/windows-runtime.md",
    "docs/history/README.md",
    "docs/history/codex-completion-findings.md",
    "docs/history/legacy-repo-codex-approval-notification-session-2026-03-18.md",
    "docs/history/tab-color-history.md",
  ].forEach((relPath) => {
    test(`${relPath} exists`, () => {
      assert(fs.existsSync(path.join(ROOT, relPath)), `${relPath} missing`);
    });
  });

  [
    "lib/codex-approval.js",
    "lib/codex-approval-notify.js",
    "lib/codex-approval-pending.js",
    "lib/codex-approval-rules.js",
    "lib/codex-approval-session-grants.js",
    "lib/codex-approval-state.js",
    "lib/codex-completion-notify.js",
    "lib/codex-completion-pending.js",
    "lib/codex-completion-receipts.js",
    "lib/codex-event-reconciliation.js",
    "lib/codex-session-events.js",
    "lib/codex-session-watch.js",
    "lib/notification-sources.js",
    "lib/codex-sidecar-state.js",
    "lib/shell-command-analysis.js",
    "docs/development.md",
    "test/specs/approval-suppression.test.js",
    "test/specs/codex-hooks-parallel.test.js",
    "test/specs/completion-fallback.test.js",
  ].forEach((relPath) => {
    test(`${relPath} removed`, () => {
      assert(!fs.existsSync(path.join(ROOT, relPath)), `${relPath} should be removed`);
    });
  });

  section("package.json");

  const pkg = JSON.parse(read("package.json"));
  test("package omits postinstall script", () => {
    assert(!pkg.scripts || !pkg.scripts.postinstall);
  });

  test("package keeps zero runtime dependencies", () => {
    assert(Object.keys(pkg.dependencies || {}).length === 0, "unexpected runtime dependencies");
  });

  test("files omits postinstall.js", () => {
    assert(!Array.isArray(pkg.files) || !pkg.files.includes("postinstall.js"));
  });

  section("Content checks");

  const cliContent = read("bin/cli.js");
  const mcpSidecarModeContent = read("lib/codex-mcp-sidecar-mode.js");
  const mcpServerContent = read("lib/codex-mcp-server.js");
  const notifyTerminalContextContent = read("lib/notify-terminal-context.js");
  const notifyRuntimeContent = read("lib/notify-runtime.js");
  const sidecarMatcherContent = read("lib/codex-sidecar-matcher.js");
  const sidecarResolverContent = read("lib/codex-sidecar-resolver.js");
  const sidecarStoreContent = read("lib/codex-sidecar-store.js");
  const sessionEventDescriptorsContent = read("lib/codex-session-event-descriptors.js");
  const sessionRolloutEventsContent = read("lib/codex-session-rollout-events.js");
  const sessionTuiEventsContent = read("lib/codex-session-tui-events.js");
  const sessionWatchFilesContent = read("lib/codex-session-watch-files.js");
  const sessionWatchHandlersContent = read("lib/codex-session-watch-handlers.js");
  const sessionWatchNotifyContent = read("lib/codex-session-watch-notify.js");
  const sessionWatchRunnerContent = read("lib/codex-session-watch-runner.js");
  const sessionWatchStreamsContent = read("lib/codex-session-watch-streams.js");
  const notificationSourceDisplayContent = read("lib/notification-source-display.js");
  const notificationSourceParsersContent = read("lib/notification-source-parsers.js");
  const mockCodexPermissionConfigContent = read("mock-codex-permission/.codex/config.toml");
  const mockCodexPermissionReadmeContent = read("mock-codex-permission/README.md");
  const sharedUtilsContent = read("lib/shared-utils.js");
  const notifyContent = read("scripts/notify.ps1");
  const startHiddenContent = read("scripts/start-hidden.vbs");
  const watcherContent = read("scripts/tab-color-watcher.ps1");

  test("cli.js is now a thin mode dispatcher with no watcher approval or completion helpers", () => {
    assert(cliContent.includes("../lib/notify-runtime"));
    assert(cliContent.includes("../lib/codex-session-watch-runner"));
    assert(cliContent.includes("../lib/codex-mcp-sidecar-mode"));
    assert(cliContent.includes("../lib/notification-source-parsers"));
    assert(!cliContent.includes('require("../lib/codex-event-reconciliation")'));
    assert(!cliContent.includes('require("../lib/codex-completion-receipts")'));
    assert(!cliContent.includes('require("../lib/codex-approval")'));
    assert(!cliContent.includes('require("../lib/codex-session-events")'));
    assert(!cliContent.includes('require("../lib/codex-session-watch")'));
    assert(!cliContent.includes('require("../lib/notification-sources")'));
    assert(!cliContent.includes("module.exports = {"));
    assert(!cliContent.includes("function handleMcpServerMessage("));
    assert(!cliContent.includes("function resolveSidecarSessionCandidate("));
    assert(!cliContent.includes("function ensureCodexSessionWatchRunning("));
    assert(!cliContent.includes("function acquireSingleInstanceLock("));
  });

  test("notify-runtime.js resolves hwnd, shell pid, and spawns watcher through launcher", () => {
    assert(notifyRuntimeContent.includes('require("./notify-terminal-context")'));
    assert(!notifyRuntimeContent.includes("function detectTerminalContext("));
    assert(notifyRuntimeContent.includes("start-tab-color-watcher.ps1"));
    assert(notifyRuntimeContent.includes("-TargetPid"));
    assert(notifyRuntimeContent.includes("launcher exited status="));
    assert(notifyRuntimeContent.includes("WatcherPidFile"));
    assert(notifyTerminalContextContent.includes("function detectTerminalContext("));
    assert(notifyTerminalContextContent.includes("function findParentInfo("));
    assert(notifyTerminalContextContent.includes("--shell-pid"));
    assert(notifyTerminalContextContent.includes("find-hwnd.ps1"));
    assert(notifyTerminalContextContent.includes("get-shell-pid.ps1"));
  });

  test("session watcher responsibilities are split across input-only modules", () => {
    assert(cliContent.includes("codex-session-watch"));
    assert(sessionWatchRunnerContent.includes("codex-tui.log"));
    assert(sessionWatchRunnerContent.includes('acquireSingleInstanceLock("codex-session-watch"'));
    assert(sessionWatchRunnerContent.includes("function runCodexSessionWatchMode("));
    assert(sessionWatchRunnerContent.includes("function ensureCodexSessionWatchRunning("));
    assert(!sessionWatchRunnerContent.includes("createApprovedCommandRuleCache"));
    assert(!sessionWatchRunnerContent.includes("flushPendingApprovalNotifications"));
    assert(!sessionWatchRunnerContent.includes("flushPendingCompletionNotifications"));
    assert(!sessionWatchRunnerContent.includes("hasCodexCompletionReceipt"));
    assert(sessionWatchFilesContent.includes("function listRolloutFiles("));
    assert(sessionWatchFilesContent.includes("function readRolloutMetadata("));
    assert(!sessionWatchFilesContent.includes("approvalPolicy"));
    assert(!sessionWatchFilesContent.includes("sandboxPolicy"));
    assert(sessionWatchHandlersContent.includes('require("./codex-session-rollout-events")'));
    assert(sessionWatchHandlersContent.includes('require("./codex-session-tui-events")'));
    assert(sessionWatchHandlersContent.includes('require("./codex-session-watch-notify")'));
    assert(!sessionWatchHandlersContent.includes('require("./codex-approval'));
    assert(!sessionWatchHandlersContent.includes('require("./codex-completion'));
    assert(sessionWatchStreamsContent.includes('require("./codex-session-watch-files")'));
    assert(sessionWatchStreamsContent.includes('require("./codex-session-watch-handlers")'));
    assert(!sessionWatchStreamsContent.includes("pendingApproval"));
    assert(!sessionWatchStreamsContent.includes("pendingCompletion"));
    assert(sessionRolloutEventsContent.includes("request_user_input"));
    assert(!sessionRolloutEventsContent.includes("PermissionRequest"));
    assert(!sessionRolloutEventsContent.includes("task_complete"));
    assert(!sessionRolloutEventsContent.includes("require_escalated"));
    assert(sessionTuiEventsContent.includes("function buildCodexTuiInputEvent("));
    assert(!sessionTuiEventsContent.includes("function buildCodexTuiApprovalEvent("));
    assert(!sessionTuiEventsContent.includes("parseCodexTuiApprovalConfirmation"));
    assert(sessionEventDescriptorsContent.includes("function buildSessionEventDedupeKey("));
    assert(!sessionEventDescriptorsContent.includes("function getCodexExecApprovalDescriptor("));
    assert(sessionWatchNotifyContent.includes("function emitCodexSessionWatchNotification("));
    assert(sessionWatchNotifyContent.includes('require("./codex-sidecar-matcher")'));
  });

  test("mcp sidecar protocol handling lives in its own module", () => {
    assert(cliContent.includes("codex-mcp-sidecar"));
    assert(cliContent.includes("Run a minimal MCP sidecar"));
    assert(mcpSidecarModeContent.includes('require("./codex-session-watch-runner")'));
    assert(mcpSidecarModeContent.includes("function runCodexMcpSidecarMode("));
    assert(mcpSidecarModeContent.includes("ensureCodexSessionWatchRunning"));
    assert(!mcpSidecarModeContent.includes("startSidecarSessionResolver"));
    assert(!mcpSidecarModeContent.includes("resolveSidecarSessionCandidate"));
    assert(mcpServerContent.includes('case "initialize"'));
    assert(mcpServerContent.includes('case "ping"'));
    assert(mcpServerContent.includes('case "tools/list"'));
    assert(mcpServerContent.includes('case "resources/list"'));
    assert(mcpServerContent.includes('case "resources/templates/list"'));
    assert(mcpServerContent.includes('case "prompts/list"'));
  });

  test("notify-runtime.js prefixes runtime log files with the package name", () => {
    assert(notifyRuntime.LOG_FILE_PREFIX === "ai-agent-notify");
    assert(notifyRuntimeContent.includes('const LOG_FILE_PREFIX = "ai-agent-notify"'));
    assert(notifyRuntimeContent.includes("function formatLogDay("));
    assert(notifyRuntimeContent.includes('`${buildRuntimeLogStem(normalizedLogId)}-${formatLogDay(now)}.log`'));
  });

  test("createRuntime exposes build identity for linked local debugging and buckets logs by day", () => {
    const fixedNow = new Date("2026-04-09T08:30:00.000+08:00");
    const runtime = notifyRuntime.createRuntime(`build-info-${process.pid}-${Date.now()}`, {
      nowProvider: () => fixedNow,
    });

    try {
      runtime.log("build identity test");
      const logContent = fs.readFileSync(runtime.logFile, "utf8");
      const normalizedLogPath = normalizeTestPath(runtime.logFile);

      assert(runtime.buildInfo.version === pkg.version);
      assert(normalizeTestPath(runtime.buildInfo.packageRoot) === normalizeTestPath(ROOT));
      assert(runtime.buildInfo.installKind === "workspace");
      assert(runtime.buildInfo.sourceFingerprint.length === 12);
      assert(normalizedLogPath.includes("/ai-agent-notify-"));
      assert(normalizedLogPath.endsWith("-2026-04-09.log"));
      assert(logContent.includes(`ver=${runtime.buildInfo.version}`));
      assert(logContent.includes(`src=${runtime.buildInfo.sourceFingerprint}`));
      assert(logContent.includes(`install=${runtime.buildInfo.installKind}`));
    } finally {
      try {
        fs.unlinkSync(runtime.logFile);
      } catch {}
    }
  });

  test("createRuntime rolls over to a new daily log file when the date changes", () => {
    const logId = `daily-rollover-${process.pid}-${Date.now()}`;
    let currentNow = new Date(2026, 3, 9, 23, 59, 58, 0);
    const runtime = notifyRuntime.createRuntime(logId, {
      nowProvider: () => currentNow,
    });
    const firstLogFile = runtime.logFile;

    try {
      runtime.log("day one");
      currentNow = new Date(2026, 3, 10, 0, 0, 2, 0);
      const secondLogFile = runtime.logFile;
      runtime.log("day two");

      assert(normalizeTestPath(firstLogFile).endsWith("-2026-04-09.log"));
      assert(normalizeTestPath(secondLogFile).endsWith("-2026-04-10.log"));
      assert(firstLogFile !== secondLogFile);
      assert(fs.readFileSync(firstLogFile, "utf8").includes("day one"));
      assert(fs.readFileSync(secondLogFile, "utf8").includes("day two"));
    } finally {
      [firstLogFile, runtime.logFile].forEach((filePath) => {
        try {
          fs.unlinkSync(filePath);
        } catch {}
      });
    }
  });

  test("session watcher lock payload stores build identity and compares current builds", () => {
    const lockName = `test-session-watch-${process.pid}-${Date.now()}`;
    const expectedBuild = {
      ...notifyRuntime.BUILD_INFO,
      sourceFingerprint: "abcdef123456",
      packageRoot: "D:\\repo\\linked-package",
      installKind: "workspace",
    };
    const payload = sessionWatchRunner.createWatcherLockPayload({
      pid: 43210,
      startedAt: "2026-04-04T00:00:00.000Z",
      buildInfo: expectedBuild,
    });
    const lockPath = path.join(notifyRuntime.LOG_DIR, `${lockName}.lock`);

    try {
      fs.mkdirSync(notifyRuntime.LOG_DIR, { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify(payload), "utf8");

      const state = sessionWatchRunner.querySingleInstanceLock(lockName);
      assert(state.pid === 43210);
      assert(state.startedAt === "2026-04-04T00:00:00.000Z");
      assert(state.buildInfo.sourceFingerprint === "abcdef123456");
      assert(state.buildInfo.packageRoot === "D:\\repo\\linked-package");
      assert(sessionWatchRunner.isWatcherBuildCurrent(state, expectedBuild));
      assert(
        !sessionWatchRunner.isWatcherBuildCurrent(state, {
          ...expectedBuild,
          sourceFingerprint: "bbbbbb654321",
        })
      );
      assert(
        !sessionWatchRunner.isWatcherBuildCurrent(state, {
          ...expectedBuild,
          packageRoot: "D:\\repo\\other-package",
        })
      );
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
  });

  test("sidecar matching and persistence are split by responsibility", () => {
    assert(sidecarMatcherContent.includes('require("./windows-paths")'));
    assert(sidecarMatcherContent.includes('require("./codex-sidecar-store")'));
    assert(sidecarMatcherContent.includes("function findSidecarTerminalContextForSession("));
    assert(sidecarMatcherContent.includes("function reconcileSidecarSessions("));
    assert(sidecarResolverContent.includes('require("./codex-session-watch-files")'));
    assert(sidecarResolverContent.includes('require("./shared-utils")'));
    assert(sidecarResolverContent.includes("function resolveSidecarSessionCandidate("));
    assert(!sidecarResolverContent.includes("function startSidecarSessionResolver("));
    assert(sidecarStoreContent.includes("function writeSidecarRecord("));
    assert(sidecarStoreContent.includes("function pruneStaleSidecarRecords("));
  });

  test("shared utils centralize argv/env and integer parsing helpers", () => {
    assert(sharedUtilsContent.includes("function getArgValue("));
    assert(sharedUtilsContent.includes("function getEnvFirst("));
    assert(sharedUtilsContent.includes("function parsePositiveInteger("));
    assert(!notifyRuntimeContent.includes("function getArgValue("));
    assert(!notifyRuntimeContent.includes("function getEnvFirst("));
    assert(!sidecarResolverContent.includes("function parsePositiveInteger("));
  });

  test("notification agent normalization is split into parser and display modules", () => {
    assert(notificationSourceParsersContent.includes('require("./notification-source-display")'));
    assert(notificationSourceParsersContent.includes("function normalizeIncomingNotification("));
    assert(notificationSourceParsersContent.includes("function normalizeCodexHookPayload("));
    assert(notificationSourceParsersContent.includes("function getIncomingPayloadCandidates("));
    assert(notificationSourceDisplayContent.includes("function createNotificationSpec("));
    assert(notificationSourceDisplayContent.includes("function canonicalizeAgentId("));
  });

  test("mock-codex-permission fixture forces local permission requests for Codex", () => {
    assert(mockCodexPermissionConfigContent.includes('approval_policy = "on-request"'));
    assert(mockCodexPermissionConfigContent.includes('sandbox_mode = "read-only"'));
    assert(mockCodexPermissionReadmeContent.includes("PermissionRequest"));
    assert(mockCodexPermissionReadmeContent.includes(".codex/config.toml"));
    assert(mockCodexPermissionReadmeContent.includes("trust"));
  });

  test("windows path normalizer keeps blank values blank", () => {
    assert(windowsPaths.normalizeWindowsPath("") === "");
    assert(windowsPaths.normalizeWindowsPath("   ") === "");
  });

  test("notify.ps1 uses native toast + flash", () => {
    assert(notifyContent.includes("ToastNotificationManager"));
    assert(notifyContent.includes("FlashWindowEx"));
    assert(!notifyContent.includes('activationType=`"protocol`"'));
    assert(notifyContent.includes("Needs Approval"));
    assert(!notifyContent.includes("Needs Permission"));
    assert(notifyContent.includes("TOAST_NOTIFY_ENTRY_POINT"));
    assert(notifyContent.includes("TOAST_NOTIFY_AGENT_ID"));
    assert(notifyContent.includes("[$agentId] $baseTitle"));
  });

  test("notify-runtime.js passes neutral notify env vars to PowerShell", () => {
    assert(notifyRuntimeContent.includes("TOAST_NOTIFY_EVENT"));
    assert(notifyRuntimeContent.includes("TOAST_NOTIFY_ENTRY_POINT"));
    assert(notifyRuntimeContent.includes("TOAST_NOTIFY_AGENT_ID"));
    assert(notifyRuntimeContent.includes("TOAST_NOTIFY_TITLE"));
    assert(notifyRuntimeContent.includes("TOAST_NOTIFY_MESSAGE"));
    assert(notifyRuntimeContent.includes("TOAST_NOTIFY_LOG_FILE"));
    assert(notifyRuntimeContent.includes("TOAST_NOTIFY_LOG_ROOT"));
    assert(notifyRuntimeContent.includes("TOAST_NOTIFY_LOG_STEM"));
    assert(!notifyRuntimeContent.includes("TOAST_NOTIFY_SOURCE"));
    assert(!notifyRuntimeContent.includes("TOAST_NOTIFY_PROJECT_DIR"));
    assert(!notifyRuntimeContent.includes("CLAUDE_NOTIFY_PROJECT_DIR"));
    assert(!notifyRuntimeContent.includes("CLAUDE_PROJECT_DIR"));
  });

  test("notify-runtime keeps hook-facing stdout clean", () => {
    const childProcess = require("child_process");
    const notifyRuntimePath = path.join(ROOT, "lib", "notify-runtime.js");
    const originalSpawn = childProcess.spawn;
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const stdoutWrites = [];
    const stderrWrites = [];
    let spawnCall = null;

    delete require.cache[require.resolve(notifyRuntimePath)];
    childProcess.spawn = (command, args, options) => {
      spawnCall = { command, args, options };
      return { on: () => {} };
    };
    process.stdout.write = (chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    };
    process.stderr.write = (chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    };

    try {
      const freshNotifyRuntime = require(notifyRuntimePath);
      freshNotifyRuntime.emitNotification({
        agentId: "codex",
        entryPointId: "hooks-mode",
        eventName: "Stop",
        title: "Done",
        message: "Task finished",
        rawEventType: "Stop",
        runtime: {
          isDev: true,
          logFile: path.join(notifyRuntime.LOG_DIR, `stdout-clean-${Date.now()}.log`),
          logStem: `stdout-clean-${Date.now()}`,
          log: () => {},
        },
        terminal: {
          hwnd: null,
          shellPid: null,
          isWindowsTerminal: true,
        },
      });
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      childProcess.spawn = originalSpawn;
      delete require.cache[require.resolve(notifyRuntimePath)];
    }

    assert(stdoutWrites.length === 0, "hook path should not write anything to stdout");
    assert(
      stderrWrites.some((chunk) => chunk.includes("\x1b]4;264;rgb:33/cc/33")),
      "expected WT color OSC on stderr"
    );
    assert(spawnCall, "expected notify PowerShell script to be spawned");
    assert(
      JSON.stringify(spawnCall.options.stdio) === JSON.stringify(["ignore", "ignore", "inherit"]),
      "hook path should ignore child stdout and keep stderr inherited"
    );
  });

  test("cli.js writes a shared bootstrap log before per-session routing", () => {
    assert(cliContent.includes('createRuntime("bootstrap")'));
    assert(cliContent.includes("bootstrap start"));
    assert(cliContent.includes("modeHint="));
  });

  test("start-hidden.vbs runs argv command hidden", () => {
    assert(startHiddenContent.includes("shell.Run command, 0, False"));
    assert(startHiddenContent.includes("WScript.Arguments.Count"));
    assert(startHiddenContent.includes("background watcher"));
  });

  test("watcher resets through console attachment plus standard streams", () => {
    assert(watcherContent.includes("Write-OscToInheritedStreams"));
    assert(watcherContent.includes("Write-OscToAttachedConsole"));
    assert(watcherContent.includes("AttachConsole"));
    assert(watcherContent.includes("TOAST_NOTIFY_LOG_ROOT"));
    assert(watcherContent.includes("TOAST_NOTIFY_LOG_STEM"));
    assert(watcherContent.includes("[Console]::OpenStandardOutput()"));
    assert(watcherContent.includes("[Console]::OpenStandardError()"));
    assert(watcherContent.includes('"$ESC]104;264$ST"'));
    assert(!watcherContent.includes("SendKeys"));
  });
};
