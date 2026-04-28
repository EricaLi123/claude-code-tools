const {
  findSidecarTerminalContextForProjectDir,
  findSidecarTerminalContextForSession,
  reconcileSidecarSessions,
} = require("./codex-sidecar-matcher");
const { emitNotification } = require("./notify-runtime");

function emitCodexApprovalNotification({
  event,
  runtime,
  terminal,
  emittedEventKeys,
  origin,
  sessionsDir,
}) {
  if (!shouldEmitEventKey(emittedEventKeys, event.dedupeKey)) {
    return false;
  }

  runtime.log(
    `${origin} event matched type=${event.eventType} sessionId=${event.sessionId || "unknown"} turnId=${event.turnId || ""} cwd=${event.projectDir || ""}`
  );

  const notificationTerminal = resolveApprovalTerminalContext({
    sessionId: event.sessionId,
    projectDir: event.projectDir,
    fallbackTerminal: terminal,
    log: runtime.log,
    sessionsDir,
  });

  const child = emitNotification({
    source: event.source,
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

function resolveApprovalTerminalContext({ sessionId, projectDir, fallbackTerminal, log, sessionsDir }) {
  let terminal = findSidecarTerminalContextForSession(sessionId, log);
  if ((!terminal || (!terminal.hwnd && !terminal.shellPid)) && sessionsDir) {
    const reconciled = reconcileSidecarSessions({
      sessionsDir,
      targetSessionId: sessionId,
      projectDir,
      log,
    });
    if (reconciled > 0 && typeof log === "function") {
      log(
        `approval terminal watcher reconcile retried sessionId=${sessionId || "unknown"} projectDir=${projectDir || ""} reconciled=${reconciled}`
      );
    }
    terminal = findSidecarTerminalContextForSession(sessionId, log);
  }

  if (!terminal || (!terminal.hwnd && !terminal.shellPid)) {
    if (typeof log === "function") {
      log(
        `approval terminal exact sidecar match missed sessionId=${sessionId || "unknown"} projectDir=${projectDir || ""}`
      );
    }

    const projectFallback = findSidecarTerminalContextForProjectDir(projectDir, log);
    if (!projectFallback || !projectFallback.hwnd) {
      if (typeof log === "function") {
        log(
          `approval terminal resolved via default fallback sessionId=${sessionId || "unknown"} projectDir=${projectDir || ""} reason=no_sidecar_match`
        );
      }
      return fallbackTerminal;
    }

    if (typeof log === "function") {
      log(
        `approval terminal resolved via project-dir fallback sessionId=${sessionId || "unknown"} projectDir=${projectDir || ""} hwnd=${projectFallback.hwnd || ""}`
      );
    }

    return {
      // Weak cwd fallback only reuses the window handle; reusing shellPid can target the wrong tab.
      hwnd: projectFallback.hwnd,
      shellPid: null,
      isWindowsTerminal: false,
    };
  }

  if (typeof log === "function") {
    log(
      `approval terminal resolved via exact sidecar match sessionId=${sessionId || "unknown"} shellPid=${terminal.shellPid || ""} hwnd=${terminal.hwnd || ""}`
    );
  }

  return {
    hwnd: terminal.hwnd,
    shellPid: terminal.shellPid,
    isWindowsTerminal: terminal.isWindowsTerminal,
  };
}

module.exports = {
  emitCodexApprovalNotification,
  resolveApprovalTerminalContext,
  shouldEmitEventKey,
};
