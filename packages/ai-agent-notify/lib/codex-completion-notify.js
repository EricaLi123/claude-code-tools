const {
  resolveApprovalTerminalContext,
  shouldEmitEventKey,
} = require("./codex-approval-notify");
const { shouldEmitCodexEventNotification } = require("./codex-event-reconciliation");
const { emitNotification } = require("./notify-runtime");

function prepareCodexCompletionNotification({
  event,
  runtime,
  terminal,
  sessionsDir,
  resolveTerminalContext = resolveApprovalTerminalContext,
}) {
  const notificationTerminal = resolveTerminalContext({
    sessionId: event && event.sessionId,
    projectDir: event && event.projectDir,
    fallbackTerminal: terminal,
    log: runtime && runtime.log,
    sessionsDir,
  });

  return {
    event,
    notificationTerminal,
  };
}

function emitPreparedCodexCompletionNotification({
  prepared,
  runtime,
  emittedEventKeys,
  origin,
  terminal,
  sessionsDir,
  resolveTerminalContext = resolveApprovalTerminalContext,
  emitNotificationImpl = emitNotification,
  shouldEmitCodexEventNotificationImpl = shouldEmitCodexEventNotification,
}) {
  const event = prepared && prepared.event;
  if (!event || !shouldEmitEventKey(emittedEventKeys, event.dedupeKey)) {
    return false;
  }

  if (!shouldEmitCodexEventNotificationImpl(event, { runtime })) {
    return false;
  }

  let notificationTerminal = prepared && prepared.notificationTerminal;
  if (isNeutralOrDefaultTerminal(notificationTerminal)) {
    notificationTerminal = resolveTerminalContext({
      sessionId: event.sessionId,
      projectDir: event.projectDir,
      fallbackTerminal: terminal || notificationTerminal || { hwnd: null, shellPid: null },
      log: runtime && runtime.log,
      sessionsDir,
    });
  }

  runtime.log(
    `${origin} completion fallback matched type=${event.eventType} sessionId=${event.sessionId || "unknown"} turnId=${event.turnId || ""} cwd=${event.projectDir || ""}`
  );

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

  if (child && typeof child.on === "function") {
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
  }

  return true;
}

function isNeutralOrDefaultTerminal(terminal) {
  return !terminal || (!terminal.hwnd && !terminal.shellPid);
}

module.exports = {
  emitPreparedCodexCompletionNotification,
  prepareCodexCompletionNotification,
};
