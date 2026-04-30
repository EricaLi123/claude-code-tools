const { createNotificationSpec } = require("./notification-source-display");
const {
  buildSessionEventDedupeKey,
  getCodexInputRequestDescriptor,
  getCodexInputRequestMessage,
  parseJsonObjectMaybe,
} = require("./codex-session-event-descriptors");

function buildCodexTuiInputEvent(line) {
  const toolCall = parseCodexTuiToolCallLine(line);
  if (!toolCall || toolCall.toolName !== "request_user_input") {
    return null;
  }

  const { sessionId, submissionId, turnId, args } = toolCall;
  const descriptor = getCodexInputRequestDescriptor(args);

  return {
    ...createNotificationSpec({
      agentId: "codex",
      entryPointId: "tui-watch",
      sessionId,
      turnId,
      eventName: "InputRequest",
      rawEventType: "request_user_input",
      message: getCodexInputRequestMessage(args),
    }),
    eventType: "request_user_input",
    dedupeKey: buildSessionEventDedupeKey({
      sessionId,
      turnId,
      fallbackId: submissionId,
      eventKind: "input",
      descriptor,
    }),
  };
}

function parseCodexTuiToolCallLine(line) {
  if (!line || !line.includes("ToolCall: ")) {
    return null;
  }

  const match = line.match(
    /thread_id=([^}:]+).*?submission\.id="([^"]+)".*?(?:turn\.id=([^ ]+).*?)?ToolCall: ([^ ]+) (\{.*\}) thread_id=/
  );

  if (!match) {
    return null;
  }

  const [, sessionId, submissionId, turnIdFromLog, toolName, rawArgs] = match;
  const args = parseJsonObjectMaybe(rawArgs);
  if (!args) {
    return null;
  }

  return {
    sessionId,
    submissionId,
    turnId: turnIdFromLog || submissionId,
    toolName,
    args,
  };
}

module.exports = {
  buildCodexTuiInputEvent,
};
