module.exports = function runStructureAndRuntimeTests(h) {
  const { assert, fs, notifyRuntime, path, read, ROOT, section, test, windowsPaths } = h;

  section("File structure");

  [
    "bin/cli.js",
    "lib/codex-sidecar-resolver.js",
    "lib/codex-sidecar-state.js",
    "lib/notification-sources.js",
    "lib/notify-runtime.js",
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
  const notifyRuntimeContent = read("lib/notify-runtime.js");
  const sidecarResolverContent = read("lib/codex-sidecar-resolver.js");
  const sidecarStateContent = read("lib/codex-sidecar-state.js");
  const notifyContent = read("scripts/notify.ps1");
  const startHiddenContent = read("scripts/start-hidden.vbs");
  const watcherContent = read("scripts/tab-color-watcher.ps1");

  test("cli.js delegates notification runtime and sidecar resolution into lib modules", () => {
    assert(cliContent.includes("../lib/notify-runtime"));
    assert(cliContent.includes("../lib/codex-sidecar-resolver"));
    assert(!cliContent.includes("function emitNotification("));
    assert(!cliContent.includes("function createRuntime("));
    assert(!cliContent.includes("function startTabColorWatcher("));
  });

  test("notify-runtime.js resolves hwnd, shell pid, and spawns watcher through launcher", () => {
    assert(notifyRuntimeContent.includes("find-hwnd.ps1"));
    assert(notifyRuntimeContent.includes("get-shell-pid.ps1"));
    assert(notifyRuntimeContent.includes("start-tab-color-watcher.ps1"));
    assert(notifyRuntimeContent.includes("--shell-pid"));
    assert(notifyRuntimeContent.includes("launcher exited status="));
    assert(notifyRuntimeContent.includes("WatcherPidFile"));
  });

  test("cli.js includes codex session watcher mode", () => {
    assert(cliContent.includes("codex-session-watch"));
    assert(cliContent.includes("exec_approval_request"));
    assert(cliContent.includes("request_permissions"));
    assert(cliContent.includes("request_user_input"));
    assert(cliContent.includes("apply_patch_approval_request"));
    assert(cliContent.includes("codex-tui.log"));
    assert(cliContent.includes("ToolCall: "));
    assert(cliContent.includes('"sandbox_permissions":"require_escalated"'));
    assert(!cliContent.includes("apply_patch_outside_workspace"));
    assert(!cliContent.includes("codex-watch"));
    assert(!cliContent.includes("waitingOnApproval"));
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

  test("notify-runtime.js prefixes runtime log files with the package name", () => {
    assert(notifyRuntime.LOG_FILE_PREFIX === "ai-agent-notify");
    assert(notifyRuntimeContent.includes('const LOG_FILE_PREFIX = "ai-agent-notify"'));
    assert(notifyRuntimeContent.includes('`${LOG_FILE_PREFIX}-${normalizedLogId}.log`'));
  });

  test("sidecar modules share Windows path helpers", () => {
    assert(sidecarStateContent.includes('require("./windows-paths")'));
    assert(!sidecarStateContent.includes("function normalizeWindowsPath("));
    assert(sidecarResolverContent.includes('require("./windows-paths")'));
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
