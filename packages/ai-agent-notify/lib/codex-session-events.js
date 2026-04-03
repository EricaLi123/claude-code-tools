const path = require("path");

const { createNotificationSpec } = require("./notification-sources");

function parseJsonObjectMaybe(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return typeof value === "object" && !Array.isArray(value) ? value : null;
}

function getCodexExecApprovalDescriptor(toolName, args) {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (command) {
    return `${toolName || "tool"}:${command}`;
  }

  return toolName || "tool";
}

function normalizeInlineText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function sanitizeDedupeDescriptorPart(value) {
  return normalizeInlineText(value).replace(/[|]/g, "/").slice(0, 80);
}

function getCodexInputRequestQuestions(args) {
  return Array.isArray(args && args.questions)
    ? args.questions.filter(
        (question) => question && typeof question === "object" && !Array.isArray(question)
      )
    : [];
}

function getCodexInputRequestDescriptor(args) {
  const questions = getCodexInputRequestQuestions(args);
  if (!questions.length) {
    return "request_user_input";
  }

  const parts = questions.slice(0, 3).map((question, index) => {
    return (
      sanitizeDedupeDescriptorPart(question.id) ||
      sanitizeDedupeDescriptorPart(question.header) ||
      sanitizeDedupeDescriptorPart(question.question) ||
      `q${index + 1}`
    );
  });

  return `request_user_input:${parts.join(",")}:${questions.length}`;
}

function getCodexInputRequestMessage(args) {
  const questions = getCodexInputRequestQuestions(args);
  if (!questions.length) {
    return "Waiting for your input";
  }

  const firstQuestion =
    normalizeInlineText(questions[0].question) || normalizeInlineText(questions[0].header);

  if (!firstQuestion) {
    return "Waiting for your input";
  }

  return questions.length > 1 ? `${firstQuestion} (+${questions.length - 1} more)` : firstQuestion;
}

function buildApprovalDedupeKey({
  sessionId,
  turnId,
  callId,
  approvalId,
  fallbackId,
  approvalKind,
  descriptor,
}) {
  return [
    sessionId || "unknown",
    approvalKind || "permission",
    turnId || approvalId || callId || fallbackId || "unknown",
    descriptor || "",
  ].join("|");
}

function parseSessionIdFromRolloutPath(filePath) {
  const match = path
    .basename(filePath)
    .match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/i);
  return match ? match[1] : "";
}

function buildCodexSessionEvent(state, record) {
  const payload = record && record.payload;
  if (!payload || typeof payload.type !== "string") {
    return null;
  }

  const sessionId = state.sessionId || parseSessionIdFromRolloutPath(state.filePath) || "unknown";
  const projectDir = payload.cwd || state.cwd || "";
  const turnId = payload.turn_id || state.turnId || "";
  const callId = payload.call_id || "";
  const approvalId = payload.approval_id || "";

  if (record.type === "response_item" && payload.type === "function_call") {
    const args = parseJsonObjectMaybe(payload.arguments);
    if (payload.name === "request_user_input" && args) {
      const descriptor = getCodexInputRequestDescriptor(args);
      return {
        ...createNotificationSpec({
          sourceId: "codex-session-watch",
          sessionId,
          turnId,
          eventName: "InputRequest",
          projectDir,
          rawEventType: payload.name,
          message: getCodexInputRequestMessage(args),
        }),
        eventType: payload.name,
        callId,
        dedupeKey: buildApprovalDedupeKey({
          sessionId,
          turnId,
          callId,
          approvalKind: "input",
          descriptor,
        }),
      };
    }

    if (!args || args.sandbox_permissions !== "require_escalated") {
      return null;
    }

    const descriptor = getCodexExecApprovalDescriptor(payload.name, args);
    const approvalProjectDir = args.workdir || projectDir;
    return {
      ...createNotificationSpec({
        sourceId: "codex-session-watch",
        sessionId,
        turnId,
        eventName: "PermissionRequest",
        projectDir: approvalProjectDir,
        rawEventType: "require_escalated_tool_call",
      }),
      eventType: "require_escalated_tool_call",
      approvalDispatch: "pending",
      callId,
      toolArgs: args,
      dedupeKey: buildApprovalDedupeKey({
        sessionId,
        turnId,
        callId,
        approvalKind: "exec",
        descriptor,
      }),
    };
  }

  if (record.type !== "event_msg") {
    return null;
  }

  switch (payload.type) {
    case "exec_approval_request":
    case "request_permissions":
      return {
        ...createNotificationSpec({
          sourceId: "codex-session-watch",
          sessionId,
          turnId,
          eventName: "PermissionRequest",
          projectDir,
          rawEventType: payload.type,
        }),
        eventType: payload.type,
        dedupeKey: buildApprovalDedupeKey({
          sessionId,
          turnId,
          callId,
          approvalId,
          approvalKind: "exec",
        }),
      };
    case "apply_patch_approval_request":
      return {
        ...createNotificationSpec({
          sourceId: "codex-session-watch",
          sessionId,
          turnId,
          eventName: "PermissionRequest",
          projectDir,
          rawEventType: payload.type,
        }),
        eventType: payload.type,
        dedupeKey: buildApprovalDedupeKey({
          sessionId,
          turnId,
          callId,
          approvalId,
          approvalKind: "patch",
        }),
      };
    default:
      return null;
  }
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
      sourceId: "codex-session-watch",
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
      sourceId: "codex-session-watch",
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

function isApprovedCommandRuleSavedRecord(record) {
  if (
    !record ||
    record.type !== "response_item" ||
    !record.payload ||
    record.payload.type !== "message" ||
    record.payload.role !== "developer" ||
    !Array.isArray(record.payload.content)
  ) {
    return false;
  }

  return record.payload.content.some(
    (item) =>
      item &&
      item.type === "input_text" &&
      typeof item.text === "string" &&
      item.text.startsWith("Approved command prefix saved:")
  );
}

module.exports = {
  buildApprovalDedupeKey,
  buildCodexSessionEvent,
  buildCodexTuiApprovalEvent,
  buildCodexTuiInputEvent,
  getCodexExecApprovalDescriptor,
  getCodexInputRequestDescriptor,
  getCodexInputRequestMessage,
  isApprovedCommandRuleSavedRecord,
  parseCodexTuiApprovalConfirmation,
  parseJsonObjectMaybe,
  parseSessionIdFromRolloutPath,
};
