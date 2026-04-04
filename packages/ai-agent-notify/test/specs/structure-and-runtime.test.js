module.exports = function runStructureAndRuntimeTests(h) {
  const { assert, fs, notifyRuntime, path, read, ROOT, section, test, windowsPaths } = h;

  section("File structure");

  [
    "bin/cli.js",
    "lib/codex-approval.js",
    "lib/codex-approval-notify.js",
    "lib/codex-approval-rules.js",
    "lib/codex-approval-pending.js",
    "lib/codex-approval-session-grants.js",
    "lib/codex-approval-state.js",
    "lib/codex-sidecar-matcher.js",
    "lib/codex-sidecar-resolver.js",
    "lib/codex-sidecar-store.js",
    "lib/codex-sidecar-state.js",
    "lib/codex-session-event-descriptors.js",
    "lib/codex-session-events.js",
    "lib/codex-session-rollout-events.js",
    "lib/codex-session-tui-events.js",
    "lib/codex-session-watch.js",
    "lib/codex-session-watch-files.js",
    "lib/codex-session-watch-handlers.js",
    "lib/codex-session-watch-streams.js",
    "lib/notification-source-display.js",
    "lib/notification-source-parsers.js",
    "lib/notification-sources.js",
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
  const approvalContent = read("lib/codex-approval.js");
  const approvalNotifyContent = read("lib/codex-approval-notify.js");
  const approvalPendingContent = read("lib/codex-approval-pending.js");
  const approvalRulesContent = read("lib/codex-approval-rules.js");
  const approvalSessionGrantsContent = read("lib/codex-approval-session-grants.js");
  const approvalStateContent = read("lib/codex-approval-state.js");
  const notifyTerminalContextContent = read("lib/notify-terminal-context.js");
  const notifyRuntimeContent = read("lib/notify-runtime.js");
  const sidecarMatcherContent = read("lib/codex-sidecar-matcher.js");
  const sidecarResolverContent = read("lib/codex-sidecar-resolver.js");
  const sidecarStoreContent = read("lib/codex-sidecar-store.js");
  const sidecarStateContent = read("lib/codex-sidecar-state.js");
  const sessionEventDescriptorsContent = read("lib/codex-session-event-descriptors.js");
  const sessionEventContent = read("lib/codex-session-events.js");
  const sessionRolloutEventsContent = read("lib/codex-session-rollout-events.js");
  const sessionTuiEventsContent = read("lib/codex-session-tui-events.js");
  const sessionWatchContent = read("lib/codex-session-watch.js");
  const sessionWatchFilesContent = read("lib/codex-session-watch-files.js");
  const sessionWatchHandlersContent = read("lib/codex-session-watch-handlers.js");
  const sessionWatchStreamsContent = read("lib/codex-session-watch-streams.js");
  const notificationSourceDisplayContent = read("lib/notification-source-display.js");
  const notificationSourceParsersContent = read("lib/notification-source-parsers.js");
  const notificationSourcesContent = read("lib/notification-sources.js");
  const shellCommandAnalysisContent = read("lib/shell-command-analysis.js");
  const sharedUtilsContent = read("lib/shared-utils.js");
  const notifyContent = read("scripts/notify.ps1");
  const startHiddenContent = read("scripts/start-hidden.vbs");
  const watcherContent = read("scripts/tab-color-watcher.ps1");

  test("cli.js delegates runtime and codex logic into lib modules", () => {
    assert(cliContent.includes("../lib/notify-runtime"));
    assert(cliContent.includes("../lib/codex-sidecar-resolver"));
    assert(cliContent.includes("../lib/codex-approval"));
    assert(cliContent.includes("../lib/codex-session-events"));
    assert(cliContent.includes("../lib/codex-session-watch"));
    assert(cliContent.includes("../lib/shared-utils"));
    assert(!cliContent.includes("function emitNotification("));
    assert(!cliContent.includes("function createRuntime("));
    assert(!cliContent.includes("function startTabColorWatcher("));
    assert(!cliContent.includes("function buildCodexSessionEvent("));
    assert(!cliContent.includes("function getCodexRequireEscalatedSuppressionReason("));
    assert(!cliContent.includes("function listRolloutFiles("));
  });

  test("notify-runtime.js resolves hwnd, shell pid, and spawns watcher through launcher", () => {
    assert(notifyRuntimeContent.includes('require("./notify-terminal-context")'));
    assert(!notifyRuntimeContent.includes("function detectTerminalContext("));
    assert(notifyRuntimeContent.includes("start-tab-color-watcher.ps1"));
    assert(notifyRuntimeContent.includes("--shell-pid"));
    assert(notifyRuntimeContent.includes("launcher exited status="));
    assert(notifyRuntimeContent.includes("WatcherPidFile"));
    assert(notifyTerminalContextContent.includes("function detectTerminalContext("));
    assert(notifyTerminalContextContent.includes("function findParentInfo("));
    assert(notifyTerminalContextContent.includes("find-hwnd.ps1"));
    assert(notifyTerminalContextContent.includes("get-shell-pid.ps1"));
  });

  test("cli.js routes codex session watcher mode while watch modules own the details", () => {
    assert(cliContent.includes("codex-session-watch"));
    assert(cliContent.includes("codex-tui.log"));
    assert(!cliContent.includes("apply_patch_outside_workspace"));
    assert(!cliContent.includes("codex-watch"));
    assert(!cliContent.includes("waitingOnApproval"));
    assert(cliContent.includes("sessionsDir"));
    assert(cliContent.includes('acquireSingleInstanceLock("codex-session-watch"'));
    assert(cliContent.includes("start-hidden.vbs"));

    assert(sessionEventContent.includes('require("./codex-session-event-descriptors")'));
    assert(sessionEventContent.includes('require("./codex-session-rollout-events")'));
    assert(sessionEventContent.includes('require("./codex-session-tui-events")'));
    assert(!sessionEventContent.includes("function buildCodexSessionEvent("));
    assert(sessionEventDescriptorsContent.includes("function getCodexInputRequestDescriptor("));
    assert(sessionRolloutEventsContent.includes("exec_approval_request"));
    assert(sessionRolloutEventsContent.includes("request_permissions"));
    assert(sessionRolloutEventsContent.includes("request_user_input"));
    assert(sessionRolloutEventsContent.includes("apply_patch_approval_request"));
    assert(sessionTuiEventsContent.includes("ToolCall: "));
    assert(sessionTuiEventsContent.includes('"sandbox_permissions":"require_escalated"'));
    assert(sessionWatchContent.includes('require("./codex-session-watch-files")'));
    assert(sessionWatchContent.includes('require("./codex-session-watch-streams")'));
    assert(!sessionWatchContent.includes("function consumeSessionFileUpdates("));
    assert(sessionWatchFilesContent.includes("function listRolloutFiles("));
    assert(sessionWatchHandlersContent.includes("function handleSessionRecord("));
    assert(sessionWatchHandlersContent.includes("function handleCodexTuiLogLine("));
    assert(sessionWatchStreamsContent.includes("function consumeSessionFileUpdates("));
    assert(sessionWatchStreamsContent.includes("tracking tui log file="));
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

  test("notify-runtime.js prefixes runtime log files with the package name", () => {
    assert(notifyRuntime.LOG_FILE_PREFIX === "ai-agent-notify");
    assert(notifyRuntimeContent.includes('const LOG_FILE_PREFIX = "ai-agent-notify"'));
    assert(notifyRuntimeContent.includes('`${LOG_FILE_PREFIX}-${normalizedLogId}.log`'));
  });

  test("sidecar modules share Windows path helpers", () => {
    assert(sidecarStateContent.includes('require("./codex-sidecar-matcher")'));
    assert(sidecarStateContent.includes('require("./codex-sidecar-store")'));
    assert(!sidecarStateContent.includes("function findSidecarTerminalContextForSession("));
    assert(sidecarMatcherContent.includes('require("./windows-paths")'));
    assert(!sidecarStateContent.includes("function normalizeWindowsPath("));
    assert(sidecarResolverContent.includes('require("./windows-paths")'));
    assert(sidecarStoreContent.includes("function writeSidecarRecord("));
  });

  test("shared utils centralize argv/env and integer parsing helpers", () => {
    assert(sharedUtilsContent.includes("function getArgValue("));
    assert(sharedUtilsContent.includes("function getEnvFirst("));
    assert(sharedUtilsContent.includes("function parsePositiveInteger("));
    assert(!notifyRuntimeContent.includes("function getArgValue("));
    assert(!notifyRuntimeContent.includes("function getEnvFirst("));
    assert(!sidecarStateContent.includes("function parsePositiveInteger("));
  });

  test("approval logic lives outside cli.js", () => {
    assert(approvalContent.includes('require("./codex-approval-notify")'));
    assert(approvalContent.includes('require("./codex-approval-rules")'));
    assert(approvalContent.includes('require("./codex-approval-state")'));
    assert(approvalContent.includes('require("./shell-command-analysis")'));
    assert(!approvalContent.includes("function getCodexRequireEscalatedSuppressionReason("));
    assert(!approvalContent.includes("function extractCommandApprovalRoots("));
    assert(!approvalContent.includes("function confirmSessionApprovalForRecentEvents("));
    assert(!approvalContent.includes("function emitCodexApprovalNotification("));
    assert(approvalRulesContent.includes("function getCodexRequireEscalatedSuppressionReason("));
    assert(approvalStateContent.includes('require("./codex-approval-pending")'));
    assert(approvalStateContent.includes('require("./codex-approval-session-grants")'));
    assert(!approvalStateContent.includes("function confirmSessionApprovalForRecentEvents("));
    assert(approvalPendingContent.includes("function flushPendingApprovalNotifications("));
    assert(approvalSessionGrantsContent.includes("function confirmSessionApprovalForRecentEvents("));
    assert(approvalNotifyContent.includes("function emitCodexApprovalNotification("));
    assert(shellCommandAnalysisContent.includes("function extractCommandApprovalRoots("));
  });

  test("notification source normalization is split into parser and display modules", () => {
    assert(notificationSourcesContent.includes('require("./notification-source-display")'));
    assert(notificationSourcesContent.includes('require("./notification-source-parsers")'));
    assert(!notificationSourcesContent.includes("function normalizeIncomingNotification("));
    assert(!notificationSourcesContent.includes("function createNotificationSpec("));
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
