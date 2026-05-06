const { buildCodexSessionEvent } = require("./codex-session-rollout-events");
const { emitCodexSessionWatchNotification } = require("./codex-session-watch-notify");
const { stripUtf8Bom } = require("./shared-utils");

function handleSessionRecord(
  state,
  line,
  {
    runtime,
    terminal,
  }
) {
  let record;
  try {
    record = JSON.parse(stripUtf8Bom(line));
  } catch (error) {
    runtime.log(`failed to parse session line file=${state.filePath} error=${error.message}`);
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
    origin: "session",
  });
}

module.exports = {
  handleSessionRecord,
};
