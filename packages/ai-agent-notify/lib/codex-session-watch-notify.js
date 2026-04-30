const { findTerminalContextForSession } = require("./codex-terminal-context-store");
const { emitNotification } = require("./notify-runtime");

function emitCodexSessionWatchNotification({
  event,
  runtime,
  terminal,
  emittedEventKeys,
  origin,
  sessionsDir,
  resolveSessionWatchTerminalContextImpl = resolveSessionWatchTerminalContext,
  emitNotificationImpl = emitNotification,
}) {
  if (!shouldEmitEventKey(emittedEventKeys, event.dedupeKey)) {
    return false;
  }

  runtime.log(
    `${origin} event matched type=${event.eventType} sessionId=${event.sessionId || "unknown"} turnId=${event.turnId || ""} cwd=${event.projectDir || ""}`
  );

  const notificationTerminal = resolveSessionWatchTerminalContextImpl({
    sessionId: event.sessionId,
    projectDir: event.projectDir,
    fallbackTerminal: terminal,
    log: runtime.log,
    sessionsDir,
  });

  const child = emitNotificationImpl({
    agentId: event.agentId,
    entryPointId: event.entryPointId,
    eventName: event.eventName,
    title: event.title,
    message: event.message,
    rawEventType: event.eventType,
    runtime,
    terminal: notificationTerminal,
  });

  child.on("close", (code) => {
    runtime.log(
      `notify.ps1 exited code=${code} sessionId=${event.sessionId || "unknown"} eventType=${event.eventType}`
    );
  });

  child.on("error", (error) => {
    runtime.log(
      `notify.ps1 spawn failed sessionId=${event.sessionId || "unknown"} eventType=${event.eventType} error=${error.message}`
    );
  });

  return true;
}

function shouldEmitEventKey(emittedEventKeys, eventKey) {
  if (!eventKey) {
    return true;
  }

  if (emittedEventKeys.has(eventKey)) {
    return false;
  }

  emittedEventKeys.set(eventKey, Date.now());
  return true;
}

function resolveSessionWatchTerminalContext({
  sessionId,
  fallbackTerminal,
  log,
}) {
  const terminal = findTerminalContextForSession(sessionId, log);

  if (!terminal || (!terminal.hwnd && !terminal.shellPid)) {
    if (typeof log === "function") {
      log(`session-watch terminal exact session match missed sessionId=${sessionId || "unknown"}`);
    }

    return fallbackTerminal;
  }

  if (typeof log === "function") {
    log(
      `session-watch terminal resolved via exact session match sessionId=${sessionId || "unknown"} shellPid=${terminal.shellPid || ""} hwnd=${terminal.hwnd || ""}`
    );
  }

  return {
    hwnd: terminal.hwnd,
    shellPid: terminal.shellPid,
    isWindowsTerminal: terminal.isWindowsTerminal,
  };
}

module.exports = {
  emitCodexSessionWatchNotification,
  resolveSessionWatchTerminalContext,
  shouldEmitEventKey,
};
