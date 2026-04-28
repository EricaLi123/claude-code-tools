const { createNotificationSpec } = require("./notification-source-display");
const {
  buildSessionEventDedupeKey,
  getCodexInputRequestDescriptor,
  getCodexInputRequestMessage,
  parseJsonObjectMaybe,
  parseSessionIdFromRolloutPath,
} = require("./codex-session-event-descriptors");

function buildCodexSessionEvent(state, record) {
  const payload = record && record.payload;
  if (
    record?.type !== "response_item" ||
    !payload ||
    payload.type !== "function_call" ||
    payload.name !== "request_user_input"
  ) {
    return null;
  }

  const args = parseJsonObjectMaybe(payload.arguments);
  if (!args) {
    return null;
  }

  const sessionId = state.sessionId || parseSessionIdFromRolloutPath(state.filePath) || "unknown";
  const projectDir = payload.cwd || state.cwd || "";
  const turnId = payload.turn_id || state.turnId || "";
  const callId = payload.call_id || "";
  const descriptor = getCodexInputRequestDescriptor(args);

  return {
    ...createNotificationSpec({
      agentId: "codex",
      entryPointId: "rollout-watch",
      sessionId,
      turnId,
      eventName: "InputRequest",
      projectDir,
      rawEventType: payload.name,
      message: getCodexInputRequestMessage(args),
    }),
    eventType: payload.name,
    callId,
    dedupeKey: buildSessionEventDedupeKey({
      sessionId,
      turnId,
      fallbackId: callId,
      eventKind: "input",
      descriptor,
    }),
  };
}

module.exports = {
  buildCodexSessionEvent,
};
