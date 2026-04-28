const { createNotificationSpec } = require("./notification-source-display");
const { buildCodexCompletionReceiptKey } = require("./codex-completion-receipts");
const {
  buildApprovalDedupeKey,
  getCodexExecApprovalDescriptor,
  getCodexInputRequestDescriptor,
  getCodexInputRequestMessage,
  parseJsonObjectMaybe,
  parseSessionIdFromRolloutPath,
} = require("./codex-session-event-descriptors");

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
    return buildSessionFunctionCallEvent({
      callId,
      payload,
      projectDir,
      sessionId,
      turnId,
    });
  }

  if (record.type !== "event_msg") {
    return null;
  }

  switch (payload.type) {
    case "exec_approval_request":
    case "request_permissions":
      return createSessionApprovalRequestEvent({
        approvalId,
        approvalKind: "exec",
        callId,
        payload,
        projectDir,
        sessionId,
        turnId,
      });
    case "apply_patch_approval_request":
      return createSessionApprovalRequestEvent({
        approvalId,
        approvalKind: "patch",
        callId,
        payload,
        projectDir,
        sessionId,
        turnId,
      });
    case "task_complete":
      return createSessionCompletionEvent({
        completionCandidatesEnabled: !!state.enableCompletionCandidates,
        payload,
        projectDir,
        sessionId,
        subagentParentSessionId: state.subagentParentSessionId || "",
        turnId,
      });
    default:
      return null;
  }
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

function buildSessionFunctionCallEvent({ callId, payload, projectDir, sessionId, turnId }) {
  const args = parseJsonObjectMaybe(payload.arguments);
  if (payload.name === "request_user_input" && args) {
    const descriptor = getCodexInputRequestDescriptor(args);
    return {
      ...createNotificationSpec({
        sourceId: "codex",
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
      sourceId: "codex",
      entryPointId: "rollout-watch",
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

function createSessionApprovalRequestEvent({
  approvalId,
  approvalKind,
  callId,
  payload,
  projectDir,
  sessionId,
  turnId,
}) {
  return {
    ...createNotificationSpec({
      sourceId: "codex",
      entryPointId: "rollout-watch",
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
      approvalKind,
    }),
  };
}

function createSessionCompletionEvent({
  completionCandidatesEnabled,
  payload,
  projectDir,
  sessionId,
  subagentParentSessionId,
  turnId,
}) {
  if (!completionCandidatesEnabled || !turnId || subagentParentSessionId) {
    return null;
  }

  const dedupeKey = buildCodexCompletionReceiptKey({
    sessionId,
    turnId,
    eventName: "Stop",
  });
  if (!dedupeKey) {
    return null;
  }

  return {
    ...createNotificationSpec({
      sourceId: "codex",
      entryPointId: "rollout-watch",
      sessionId,
      turnId,
      eventName: "Stop",
      projectDir,
      rawEventType: payload.type,
    }),
    eventType: payload.type,
    dedupeKey,
  };
}

module.exports = {
  buildCodexSessionEvent,
  isApprovedCommandRuleSavedRecord,
};
