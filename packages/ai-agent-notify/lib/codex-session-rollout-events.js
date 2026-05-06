const { createNotificationSpec } = require("./notification-source-display");
const {
  getCodexInputRequestMessage,
  parseJsonObjectMaybe,
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

  const sessionId = state.sessionId || "unknown";
  const event = {
    ...createNotificationSpec({
      agentId: "codex",
      entryPointId: "rollout-watch",
      sessionId,
      eventName: "InputRequest",
      rawEventType: payload.name,
      message: getCodexInputRequestMessage(args),
    }),
    eventType: payload.name,
  };

  delete event.turnId;
  return event;
}

module.exports = {
  buildCodexSessionEvent,
};
