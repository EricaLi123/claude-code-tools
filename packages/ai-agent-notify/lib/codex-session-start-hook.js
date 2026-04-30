const { ensureCodexSessionWatchRunning } = require("./codex-session-watch-runner");
const { writeTerminalContextRecord } = require("./codex-terminal-context-store");
const { createRuntime, detectTerminalContext } = require("./notify-runtime");

function runCodexSessionStartHook({
  argv = [],
  cliPath,
  payload,
  createRuntimeImpl = createRuntime,
  detectTerminalContextImpl = detectTerminalContext,
  ensureCodexSessionWatchRunningImpl = ensureCodexSessionWatchRunning,
  writeTerminalContextRecordImpl = writeTerminalContextRecord,
}) {
  const sessionId = payload && payload.sessionId ? payload.sessionId : "unknown";
  const runtime = createRuntimeImpl(`codex-session-start-${sessionId || Date.now()}`);

  runtime.log(
    `started mode=codex-session-start sessionId=${sessionId} packageRoot=${runtime.buildInfo.packageRoot}`
  );

  const watcher = ensureCodexSessionWatchRunningImpl({
    cliPath,
    log: runtime.log,
  });
  const terminal = detectTerminalContextImpl(argv, runtime.log);

  if (!terminal.hwnd && !terminal.shellPid) {
    runtime.log(`session-start terminal context unavailable sessionId=${sessionId}`);
    return { handled: true, watcher, terminal, record: null };
  }

  const record = writeTerminalContextRecordImpl({
    sessionId,
    hwnd: terminal.hwnd,
    shellPid: terminal.shellPid,
    isWindowsTerminal: terminal.isWindowsTerminal,
  });

  runtime.log(
    `stored session terminal context sessionId=${record.sessionId} hwnd=${record.hwnd || ""} shellPid=${
      record.shellPid || ""
    } isWindowsTerminal=${record.isWindowsTerminal ? "1" : "0"}`
  );

  return { handled: true, watcher, terminal, record };
}

module.exports = {
  runCodexSessionStartHook,
};
