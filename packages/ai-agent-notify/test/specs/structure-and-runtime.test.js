module.exports = function runStructureAndRuntimeTests(h) {
  const { assert, fs, normalizeTestPath, notifyRuntime, path, read, ROOT, section, test, windowsPaths } = h;

  section("File structure");

  [
    "bin/cli.js",
    "lib/codex-approval-notify.js",
    "lib/codex-approval-pending.js",
    "lib/codex-approval-rules.js",
    "lib/codex-approval-session-grants.js",
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
    "lib/codex-session-watch-runner.js",
    "lib/codex-session-watch-streams.js",
    "lib/notification-source-display.js",
    "lib/notification-source-parsers.js",
    "lib/notify-terminal-context.js",
    "lib/notify-runtime.js",
    "lib/shell-command-analysis.js",
    "lib/shared-utils.js",
    "lib/windows-paths.js",
    "scripts/find-hwnd.ps1",
    "scripts/get-shell-pid.ps1",
    "scripts/manual/test-toast.ps1",
    "scripts/notify.ps1",
    "scripts/start-hidden.vbs",
    "scripts/start-tab-color-watcher.ps1",
    "scripts/tab-color-watcher.ps1",
    "docs/development.md",
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
    "lib/codex-approval-state.js",
    "lib/codex-session-events.js",
    "lib/codex-session-watch.js",
    "lib/notification-sources.js",
    "lib/codex-sidecar-state.js",
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
  const approvalNotifyContent = read("lib/codex-approval-notify.js");
  const approvalPendingContent = read("lib/codex-approval-pending.js");
  const approvalRulesContent = read("lib/codex-approval-rules.js");
  const approvalSessionGrantsContent = read("lib/codex-approval-session-grants.js");
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
  const sessionWatchRunnerContent = read("lib/codex-session-watch-runner.js");
  const sessionWatchStreamsContent = read("lib/codex-session-watch-streams.js");
  const notificationSourceDisplayContent = read("lib/notification-source-display.js");
  const notificationSourceParsersContent = read("lib/notification-source-parsers.js");
  const shellCommandAnalysisContent = read("lib/shell-command-analysis.js");
  const sharedUtilsContent = read("lib/shared-utils.js");
  const notifyContent = read("scripts/notify.ps1");
  const startHiddenContent = read("scripts/start-hidden.vbs");
  const watcherContent = read("scripts/tab-color-watcher.ps1");

  test("cli.js is now a thin mode dispatcher with no test export surface", () => {
    assert(cliContent.includes("../lib/notify-runtime"));
    assert(cliContent.includes("../lib/codex-session-watch-runner"));
    assert(cliContent.includes("../lib/codex-mcp-sidecar-mode"));
    assert(cliContent.includes("../lib/notification-source-parsers"));
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

  test("session watcher responsibilities are split across dedicated modules", () => {
    assert(cliContent.includes("codex-session-watch"));
    assert(sessionWatchRunnerContent.includes("codex-tui.log"));
    assert(sessionWatchRunnerContent.includes('acquireSingleInstanceLock("codex-session-watch"'));
    assert(sessionWatchRunnerContent.includes("function runCodexSessionWatchMode("));
    assert(sessionWatchRunnerContent.includes("function ensureCodexSessionWatchRunning("));
    assert(sessionWatchFilesContent.includes("function listRolloutFiles("));
    assert(sessionWatchFilesContent.includes('require("./codex-session-event-descriptors")'));
    assert(sessionWatchHandlersContent.includes('require("./codex-approval-pending")'));
    assert(sessionWatchHandlersContent.includes('require("./codex-approval-notify")'));
    assert(sessionWatchHandlersContent.includes('require("./codex-approval-rules")'));
    assert(sessionWatchHandlersContent.includes('require("./codex-approval-session-grants")'));
    assert(sessionWatchHandlersContent.includes('require("./codex-session-rollout-events")'));
    assert(sessionWatchHandlersContent.includes('require("./codex-session-tui-events")'));
    assert(sessionWatchHandlersContent.includes('require("./codex-session-event-descriptors")'));
    assert(sessionWatchStreamsContent.includes('require("./codex-session-watch-files")'));
    assert(sessionWatchStreamsContent.includes('require("./codex-session-watch-handlers")'));
    assert(sessionWatchStreamsContent.includes("function consumeSessionFileUpdates("));
    assert(sessionRolloutEventsContent.includes("function buildCodexSessionEvent("));
    assert(sessionRolloutEventsContent.includes("request_user_input"));
    assert(sessionTuiEventsContent.includes("function buildCodexTuiApprovalEvent("));
    assert(sessionTuiEventsContent.includes("function buildCodexTuiInputEvent("));
    assert(sessionEventDescriptorsContent.includes("function buildApprovalDedupeKey("));
  });

  test("mcp sidecar protocol handling lives in its own module", () => {
    assert(cliContent.includes("codex-mcp-sidecar"));
    assert(cliContent.includes("Run a minimal MCP sidecar"));
    assert(mcpSidecarModeContent.includes('require("./codex-session-watch-runner")'));
    assert(mcpSidecarModeContent.includes("function runCodexMcpSidecarMode("));
    assert(mcpSidecarModeContent.includes("ensureCodexSessionWatchRunning"));
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
    assert(notifyRuntimeContent.includes('`${LOG_FILE_PREFIX}-${normalizedLogId}.log`'));
  });

  test("createRuntime exposes build identity for linked local debugging", () => {
    const runtime = notifyRuntime.createRuntime(`build-info-${process.pid}-${Date.now()}`);

    try {
      runtime.log("build identity test");
      const logContent = fs.readFileSync(runtime.logFile, "utf8");

      assert(runtime.buildInfo.version === pkg.version);
      assert(normalizeTestPath(runtime.buildInfo.packageRoot) === normalizeTestPath(ROOT));
      assert(runtime.buildInfo.installKind === "workspace");
      assert(runtime.buildInfo.sourceFingerprint.length === 12);
      assert(logContent.includes(`ver=${runtime.buildInfo.version}`));
      assert(logContent.includes(`src=${runtime.buildInfo.sourceFingerprint}`));
      assert(logContent.includes(`install=${runtime.buildInfo.installKind}`));
    } finally {
      try {
        fs.unlinkSync(runtime.logFile);
      } catch {}
    }
  });

  test("sidecar matching and persistence are split by responsibility", () => {
    assert(sidecarMatcherContent.includes('require("./windows-paths")'));
    assert(sidecarMatcherContent.includes('require("./codex-sidecar-store")'));
    assert(sidecarMatcherContent.includes("function findSidecarTerminalContextForSession("));
    assert(sidecarResolverContent.includes('require("./codex-session-watch-files")'));
    assert(sidecarResolverContent.includes('require("./shared-utils")'));
    assert(sidecarResolverContent.includes("function resolveSidecarSessionCandidate("));
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

  test("approval logic is split across focused modules", () => {
    assert(approvalNotifyContent.includes('require("./codex-sidecar-matcher")'));
    assert(approvalNotifyContent.includes("function resolveApprovalTerminalContext("));
    assert(approvalPendingContent.includes("function flushPendingApprovalNotifications("));
    assert(approvalPendingContent.includes("function buildPendingApprovalBatchKey("));
    assert(approvalRulesContent.includes("function parseApprovedCommandRules("));
    assert(approvalRulesContent.includes("function getCodexRequireEscalatedSuppressionReason("));
    assert(approvalSessionGrantsContent.includes("function rememberRecentRequireEscalatedEvent("));
    assert(approvalSessionGrantsContent.includes("function confirmSessionApprovalForRecentEvents("));
    assert(shellCommandAnalysisContent.includes("function extractCommandApprovalRoots("));
    assert(shellCommandAnalysisContent.includes("function isLikelyReadOnlyShellCommand("));
  });

  test("notification source normalization is split into parser and display modules", () => {
    assert(notificationSourceParsersContent.includes('require("./notification-source-display")'));
    assert(notificationSourceParsersContent.includes("function normalizeIncomingNotification("));
    assert(notificationSourceParsersContent.includes("function getIncomingPayloadCandidates("));
    assert(notificationSourceDisplayContent.includes("function createNotificationSpec("));
    assert(notificationSourceDisplayContent.includes("function getSourceFamily("));
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
    assert(notifyContent.includes("[$source] $baseTitle"));
  });

  test("notify-runtime.js passes neutral notify env vars to PowerShell", () => {
    assert(notifyRuntimeContent.includes("TOAST_NOTIFY_EVENT"));
    assert(notifyRuntimeContent.includes("TOAST_NOTIFY_SOURCE"));
    assert(notifyRuntimeContent.includes("TOAST_NOTIFY_TITLE"));
    assert(notifyRuntimeContent.includes("TOAST_NOTIFY_MESSAGE"));
    assert(notifyRuntimeContent.includes("TOAST_NOTIFY_LOG_FILE"));
    assert(!notifyRuntimeContent.includes("TOAST_NOTIFY_PROJECT_DIR"));
    assert(!notifyRuntimeContent.includes("CLAUDE_NOTIFY_PROJECT_DIR"));
    assert(!notifyRuntimeContent.includes("CLAUDE_PROJECT_DIR"));
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
    assert(watcherContent.includes("[Console]::OpenStandardOutput()"));
    assert(watcherContent.includes("[Console]::OpenStandardError()"));
    assert(watcherContent.includes('"$ESC]104;264$ST"'));
    assert(!watcherContent.includes("SendKeys"));
  });
};
