const fs = require("fs");
const path = require("path");
const { StringDecoder } = require("string_decoder");

const {
  cancelPendingApprovalNotification,
  cancelPendingApprovalNotificationsBySuppression,
  confirmSessionApprovalForRecentEvents,
  emitCodexApprovalNotification,
  getApprovedCommandRules,
  getCodexRequireEscalatedSuppressionReason,
  getSessionRequireEscalatedSuppressionReason,
  queuePendingApprovalNotification,
  rememberRecentRequireEscalatedEvent,
} = require("./codex-approval");
const {
  buildCodexSessionEvent,
  buildCodexTuiApprovalEvent,
  buildCodexTuiInputEvent,
  isApprovedCommandRuleSavedRecord,
  parseCodexTuiApprovalConfirmation,
  parseSessionIdFromRolloutPath,
} = require("./codex-session-events");
const { fileExistsCaseInsensitive, stripUtf8Bom } = require("./shared-utils");

function listRolloutFiles(rootDir, log) {
  if (!rootDir || !fileExistsCaseInsensitive(rootDir)) {
    return [];
  }

  const files = [];
  const pendingDirs = [rootDir];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    let entries = [];

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      log(`readdir failed dir=${currentDir} error=${error.message}`);
      continue;
    }

    entries.forEach((entry) => {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(entryPath);
        return;
      }

      if (
        entry.isFile() &&
        /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-.+\.jsonl$/i.test(entry.name)
      ) {
        files.push(entryPath);
      }
    });
  }

  files.sort();
  return files;
}

function createSessionFileState(filePath) {
  return {
    filePath,
    sessionId: parseSessionIdFromRolloutPath(filePath),
    cwd: "",
    turnId: "",
    approvalPolicy: "",
    sandboxPolicy: null,
    position: 0,
    partial: "",
    decoder: new StringDecoder("utf8"),
  };
}

function createTailFileState(filePath) {
  return {
    filePath,
    position: 0,
    partial: "",
    decoder: new StringDecoder("utf8"),
  };
}

function bootstrapExistingSessionFileState(state, stat, log) {
  const metadata = readRolloutMetadata(state.filePath, log);
  state.sessionId = metadata.sessionId || state.sessionId;
  state.cwd = metadata.cwd || state.cwd;
  state.approvalPolicy = metadata.approvalPolicy || state.approvalPolicy;
  state.sandboxPolicy = metadata.sandboxPolicy || state.sandboxPolicy;
  bootstrapTailFileState(state, stat);
}

function bootstrapTailFileState(state, stat) {
  state.position = stat.size;
  state.partial = "";
  state.decoder = new StringDecoder("utf8");
}

function readRolloutMetadata(filePath, log) {
  const result = {
    sessionId: parseSessionIdFromRolloutPath(filePath),
    cwd: "",
    approvalPolicy: "",
    sandboxPolicy: null,
    latestEventAtMs: 0,
  };

  try {
    const stat = fs.statSync(filePath);
    if (!stat.size) {
      return result;
    }

    const headBytesToRead = Math.min(stat.size, 65536);
    const headBuffer = readFileRange(filePath, 0, headBytesToRead);
    consumeRolloutMetadataChunk(result, headBuffer, false);

    if (stat.size > headBytesToRead) {
      const tailBytesToRead = Math.min(stat.size, 262144);
      const tailBuffer = readFileRange(filePath, stat.size - tailBytesToRead, tailBytesToRead);
      consumeRolloutMetadataChunk(result, tailBuffer, true);
    }
  } catch (error) {
    log(`metadata read failed file=${filePath} error=${error.message}`);
  }

  return result;
}

function consumeRolloutMetadataChunk(result, buffer, preferLatestTurnContext) {
  const lines = buffer.toString("utf8").split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(stripUtf8Bom(line));
    } catch {
      continue;
    }

    const recordTimestampMs = Date.parse(record.timestamp || "");
    if (Number.isFinite(recordTimestampMs) && recordTimestampMs > result.latestEventAtMs) {
      result.latestEventAtMs = recordTimestampMs;
    }

    if (record.type === "session_meta" && record.payload) {
      if (record.payload.id) {
        result.sessionId = record.payload.id;
      }
      if (!result.cwd && record.payload.cwd) {
        result.cwd = record.payload.cwd;
      }
    }

    if (record.type === "turn_context" && record.payload) {
      if ((preferLatestTurnContext || !result.cwd) && record.payload.cwd) {
        result.cwd = record.payload.cwd;
      }
      if ((preferLatestTurnContext || !result.approvalPolicy) && record.payload.approval_policy) {
        result.approvalPolicy = record.payload.approval_policy;
      }
      if (
        (preferLatestTurnContext || !result.sandboxPolicy) &&
        record.payload.sandbox_policy
      ) {
        result.sandboxPolicy = record.payload.sandbox_policy;
      }
    }
  }
}

function readFileRange(filePath, start, length) {
  const handle = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, length));
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, Math.max(0, start));
    return buffer.slice(0, bytesRead);
  } finally {
    fs.closeSync(handle);
  }
}

function consumeSessionFileUpdates(
  state,
  stat,
  {
    runtime,
    terminal,
    emittedEventKeys,
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    recentRequireEscalatedEvents,
    sessionApprovalGrants,
    approvedCommandRuleCache,
  }
) {
  if (stat.size < state.position) {
    runtime.log(`session file truncated file=${state.filePath} previous=${state.position} next=${stat.size}`);
    state.position = 0;
    state.partial = "";
    state.decoder = new StringDecoder("utf8");
  }

  if (stat.size === state.position) {
    return;
  }

  const handle = fs.openSync(state.filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, stat.size - state.position));
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, state.position);
    state.position += bytesRead;

    let text = state.decoder.write(buffer.slice(0, bytesRead));
    if (state.partial) {
      text = state.partial + text;
      state.partial = "";
    }

    const lines = text.split(/\r?\n/);
    if (text && !text.endsWith("\n") && !text.endsWith("\r")) {
      state.partial = lines.pop() || "";
    }

    lines.forEach((line) => {
      if (!line.trim()) {
        return;
      }
      handleSessionRecord(state, line, {
        runtime,
        terminal,
        emittedEventKeys,
        pendingApprovalNotifications,
        pendingApprovalCallIds,
        recentRequireEscalatedEvents,
        sessionApprovalGrants,
        approvedCommandRuleCache,
      });
    });
  } finally {
    fs.closeSync(handle);
  }
}

function syncCodexTuiLogState(state, tuiLogPath, context) {
  const fileExists = fileExistsCaseInsensitive(tuiLogPath);
  if (!fileExists) {
    return null;
  }

  let stat;
  try {
    stat = fs.statSync(tuiLogPath);
  } catch (error) {
    context.runtime.log(`tui log stat failed file=${tuiLogPath} error=${error.message}`);
    return state;
  }

  let nextState = state;
  if (!nextState || nextState.filePath !== tuiLogPath) {
    nextState = createTailFileState(tuiLogPath);
    if (context.initialScan) {
      bootstrapTailFileState(nextState, stat);
    }
    context.runtime.log(
      `tracking tui log file=${tuiLogPath} position=${nextState.position} initialScan=${
        context.initialScan ? "1" : "0"
      }`
    );
  }

  consumeCodexTuiLogUpdates(nextState, stat, context);
  return nextState;
}

function consumeCodexTuiLogUpdates(
  state,
  stat,
  {
    runtime,
    terminal,
    emittedEventKeys,
    sessionProjectDirs,
    sessionApprovalContexts,
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    recentRequireEscalatedEvents,
    sessionApprovalGrants,
    approvedCommandRuleCache,
  }
) {
  if (stat.size < state.position) {
    runtime.log(`tui log truncated file=${state.filePath} previous=${state.position} next=${stat.size}`);
    state.position = 0;
    state.partial = "";
    state.decoder = new StringDecoder("utf8");
  }

  if (stat.size === state.position) {
    return;
  }

  const handle = fs.openSync(state.filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, stat.size - state.position));
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, state.position);
    state.position += bytesRead;

    let text = state.decoder.write(buffer.slice(0, bytesRead));
    if (state.partial) {
      text = state.partial + text;
      state.partial = "";
    }

    const lines = text.split(/\r?\n/);
    if (text && !text.endsWith("\n") && !text.endsWith("\r")) {
      state.partial = lines.pop() || "";
    }

    lines.forEach((line) => {
      handleCodexTuiLogLine(state, line, {
        runtime,
        terminal,
        emittedEventKeys,
        sessionProjectDirs,
        sessionApprovalContexts,
        pendingApprovalNotifications,
        pendingApprovalCallIds,
        recentRequireEscalatedEvents,
        sessionApprovalGrants,
        approvedCommandRuleCache,
      });
    });
  } finally {
    fs.closeSync(handle);
  }
}

function handleSessionRecord(
  state,
  line,
  {
    runtime,
    terminal,
    emittedEventKeys,
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    recentRequireEscalatedEvents,
    sessionApprovalGrants,
    approvedCommandRuleCache,
  }
) {
  let record;
  try {
    record = JSON.parse(stripUtf8Bom(line));
  } catch (error) {
    runtime.log(`failed to parse session line file=${state.filePath} error=${error.message}`);
    return;
  }

  if (record.type === "session_meta" && record.payload) {
    if (record.payload.id) {
      state.sessionId = record.payload.id;
    }
    if (record.payload.cwd) {
      state.cwd = record.payload.cwd;
    }
    return;
  }

  if (record.type === "turn_context" && record.payload) {
    if (record.payload.cwd) {
      state.cwd = record.payload.cwd;
    }
    if (record.payload.turn_id) {
      state.turnId = record.payload.turn_id;
    }
    if (record.payload.approval_policy) {
      state.approvalPolicy = record.payload.approval_policy;
    }
    if (record.payload.sandbox_policy) {
      state.sandboxPolicy = record.payload.sandbox_policy;
    }
    return;
  }

  if (
    record.type === "response_item" &&
    record.payload &&
    record.payload.type === "function_call_output" &&
    record.payload.call_id
  ) {
    cancelPendingApprovalNotification({
      runtime,
      pendingApprovalNotifications,
      pendingApprovalCallIds,
      callId: record.payload.call_id,
      reason: "function_call_output",
    });
    return;
  }

  if (isApprovedCommandRuleSavedRecord(record)) {
    confirmSessionApprovalForRecentEvents({
      recentRequireEscalatedEvents,
      runtime,
      sessionApprovalGrants,
      sessionId: state.sessionId || parseSessionIdFromRolloutPath(state.filePath) || "",
      source: "approved_rule_saved",
      turnId: state.turnId || "",
    });
    cancelPendingApprovalNotificationsBySuppression({
      runtime,
      pendingApprovalNotifications,
      pendingApprovalCallIds,
      sessionId: state.sessionId || parseSessionIdFromRolloutPath(state.filePath) || "",
      turnId: state.turnId || "",
      approvalPolicy: state.approvalPolicy || "",
      sandboxPolicy: state.sandboxPolicy || null,
      approvedCommandRules: getApprovedCommandRules(approvedCommandRuleCache, runtime.log),
      sessionApprovalGrants,
    });
    return;
  }

  if (
    (record.type !== "event_msg" && record.type !== "response_item") ||
    !record.payload ||
    typeof record.payload.type !== "string"
  ) {
    return;
  }

  const event = buildCodexSessionEvent(state, record);
  if (!event) {
    return;
  }

  if (event.eventType === "require_escalated_tool_call") {
    const suppressionReason = getCodexRequireEscalatedSuppressionReason({
      event,
      approvalPolicy: state.approvalPolicy,
      sandboxPolicy: state.sandboxPolicy,
      approvedCommandRules: getApprovedCommandRules(approvedCommandRuleCache, runtime.log),
    });

    if (suppressionReason) {
      runtime.log(
        `suppressed session require_escalated sessionId=${event.sessionId || "unknown"} turnId=${event.turnId || ""} reason=${suppressionReason}`
      );
      return;
    }

    const sessionSuppressionReason = getSessionRequireEscalatedSuppressionReason({
      event,
      sessionApprovalGrants,
    });
    if (sessionSuppressionReason) {
      runtime.log(
        `suppressed session require_escalated sessionId=${event.sessionId || "unknown"} turnId=${event.turnId || ""} reason=${sessionSuppressionReason}`
      );
      return;
    }

    rememberRecentRequireEscalatedEvent(recentRequireEscalatedEvents, event);

    if (event.approvalDispatch === "immediate") {
      emitCodexApprovalNotification({
        event,
        runtime,
        terminal,
        emittedEventKeys,
        origin: "session",
      });
      return;
    }

    queuePendingApprovalNotification({
      runtime,
      pendingApprovalNotifications,
      pendingApprovalCallIds,
      emittedEventKeys,
      event,
    });
    return;
  }

  emitCodexApprovalNotification({
    event,
    runtime,
    terminal,
    emittedEventKeys,
    origin: "session",
  });
}

function handleCodexTuiLogLine(
  tuiState,
  line,
  {
    runtime,
    terminal,
    emittedEventKeys,
    sessionProjectDirs,
    sessionApprovalContexts,
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    recentRequireEscalatedEvents,
    sessionApprovalGrants,
    approvedCommandRuleCache,
  }
) {
  if (!line || !line.trim()) {
    return;
  }

  const confirmation = parseCodexTuiApprovalConfirmation(line);
  if (confirmation) {
    const approvalContext = sessionApprovalContexts.get(confirmation.sessionId || "");
    confirmSessionApprovalForRecentEvents({
      recentRequireEscalatedEvents,
      runtime,
      sessionApprovalGrants,
      sessionId: confirmation.sessionId,
      source: confirmation.source,
    });
    cancelPendingApprovalNotificationsBySuppression({
      runtime,
      pendingApprovalNotifications,
      pendingApprovalCallIds,
      sessionId: confirmation.sessionId,
      approvalPolicy: (approvalContext && approvalContext.approvalPolicy) || "",
      sandboxPolicy: (approvalContext && approvalContext.sandboxPolicy) || null,
      sessionApprovalGrants,
    });
    return;
  }

  const event =
    buildCodexTuiApprovalEvent(tuiState, line, {
      sessionProjectDirs,
      sessionApprovalContexts,
    }) ||
    buildCodexTuiInputEvent(tuiState, line, {
      sessionProjectDirs,
    });
  if (!event) {
    return;
  }

  if (event.eventType !== "require_escalated_tool_call") {
    emitCodexApprovalNotification({
      event,
      runtime,
      terminal,
      emittedEventKeys,
      origin: "tui",
    });
    return;
  }

  const approvalContext = sessionApprovalContexts.get(event.sessionId || "");
  const suppressionReason = getCodexRequireEscalatedSuppressionReason({
    event,
    approvalPolicy: approvalContext && approvalContext.approvalPolicy,
    sandboxPolicy: approvalContext && approvalContext.sandboxPolicy,
    approvedCommandRules: getApprovedCommandRules(approvedCommandRuleCache, runtime.log),
  });

  if (suppressionReason) {
    runtime.log(
      `suppressed tui require_escalated sessionId=${event.sessionId || "unknown"} turnId=${event.turnId || ""} reason=${suppressionReason}`
    );
    return;
  }

  const sessionSuppressionReason = getSessionRequireEscalatedSuppressionReason({
    event,
    sessionApprovalGrants,
  });
  if (sessionSuppressionReason) {
    runtime.log(
      `suppressed tui require_escalated sessionId=${event.sessionId || "unknown"} turnId=${event.turnId || ""} reason=${sessionSuppressionReason}`
    );
    return;
  }

  rememberRecentRequireEscalatedEvent(recentRequireEscalatedEvents, event);

  queuePendingApprovalNotification({
    runtime,
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    emittedEventKeys,
    event,
  });
}

function pruneEmittedEventKeys(emittedEventKeys, maxSize) {
  while (emittedEventKeys.size > maxSize) {
    const firstKey = emittedEventKeys.keys().next();
    if (firstKey.done) {
      return;
    }
    emittedEventKeys.delete(firstKey.value);
  }
}

module.exports = {
  bootstrapExistingSessionFileState,
  createSessionFileState,
  createTailFileState,
  listRolloutFiles,
  pruneEmittedEventKeys,
  readRolloutMetadata,
  syncCodexTuiLogState,
  consumeSessionFileUpdates,
};
