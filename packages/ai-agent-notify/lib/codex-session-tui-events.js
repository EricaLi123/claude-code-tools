const { createNotificationSpec } = require("./notification-source-display");
const {
  buildApprovalDedupeKey,
  getCodexExecApprovalDescriptor,
  getCodexInputRequestDescriptor,
  getCodexInputRequestMessage,
  parseJsonObjectMaybe,
} = require("./codex-session-event-descriptors");

function buildCodexTuiApprovalEvent(tuiState, line, { sessionProjectDirs, sessionApprovalContexts }) {
  if (!line.includes('"sandbox_permissions":"require_escalated"')) {
    return null;
  }

  const toolCall = parseCodexTuiToolCallLine(line);
  if (!toolCall || toolCall.toolName !== "shell_command") {
    return null;
  }

  const { sessionId, submissionId, turnId, args } = toolCall;
  if (!args || args.sandbox_permissions !== "require_escalated") {
    return null;
  }

  const projectDir = args.workdir || sessionProjectDirs.get(sessionId) || "";
  const descriptor = getCodexExecApprovalDescriptor("shell_command", args);

  return {
    ...createNotificationSpec({
      agentId: "codex",
      entryPointId: "tui-watch",
      sessionId,
      turnId,
      eventName: "PermissionRequest",
      projectDir,
      rawEventType: "require_escalated_tool_call",
    }),
    eventType: "require_escalated_tool_call",
    approvalDispatch: "pending",
    approvalPolicy:
      sessionApprovalContexts && sessionApprovalContexts.get(sessionId)
        ? sessionApprovalContexts.get(sessionId).approvalPolicy || ""
        : "",
    callId: "",
    toolArgs: args,
    dedupeKey: buildApprovalDedupeKey({
      sessionId,
      turnId,
      fallbackId: submissionId,
      approvalKind: "exec",
      descriptor,
    }),
  };
}

function buildCodexTuiInputEvent(tuiState, line, { sessionProjectDirs }) {
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
      projectDir: sessionProjectDirs.get(sessionId) || "",
      rawEventType: "request_user_input",
      message: getCodexInputRequestMessage(args),
    }),
    eventType: "request_user_input",
    dedupeKey: buildApprovalDedupeKey({
      sessionId,
      turnId,
      fallbackId: submissionId,
      approvalKind: "input",
      descriptor,
    }),
  };
}

function parseCodexTuiApprovalConfirmation(line) {
  if (!line || !line.includes("thread_id=")) {
    return null;
  }

  let source = "";
  if (line.includes('otel.name="op.dispatch.exec_approval"')) {
    source = "tui_exec_approval";
  } else if (line.includes('otel.name="op.dispatch.patch_approval"')) {
    source = "tui_patch_approval";
  } else {
    return null;
  }

  const match = line.match(/thread_id=([^}:]+)/);
  if (!match) {
    return null;
  }

  return {
    sessionId: match[1],
    source,
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
  buildCodexTuiApprovalEvent,
  buildCodexTuiInputEvent,
  parseCodexTuiApprovalConfirmation,
};
