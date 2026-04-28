const { buildCodexSessionEvent } = require("./codex-session-rollout-events");
const { buildCodexTuiInputEvent } = require("./codex-session-tui-events");
const { emitCodexSessionWatchNotification } = require("./codex-session-watch-notify");
const { stripUtf8Bom } = require("./shared-utils");

function handleSessionRecord(
  state,
  line,
  {
    runtime,
    sessionsDir,
    terminal,
    emittedEventKeys,
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

  emitCodexSessionWatchNotification({
    event,
    runtime,
    terminal,
    emittedEventKeys,
    origin: "session",
    sessionsDir,
  });
}

function handleCodexTuiLogLine(
  tuiState,
  line,
  {
    runtime,
    sessionsDir,
    terminal,
    emittedEventKeys,
    sessionProjectDirs,
  }
) {
  if (!line || !line.trim()) {
    return;
  }

  const event = buildCodexTuiInputEvent(tuiState, line, {
    sessionProjectDirs,
  });
  if (!event) {
    return;
  }

  emitCodexSessionWatchNotification({
    event,
    runtime,
    terminal,
    emittedEventKeys,
    origin: "tui",
    sessionsDir,
  });
}

module.exports = {
  handleCodexTuiLogLine,
  handleSessionRecord,
};
