const fs = require("fs");
const { StringDecoder } = require("string_decoder");

const { fileExistsCaseInsensitive } = require("./shared-utils");
const {
  bootstrapTailFileState,
  createTailFileState,
} = require("./codex-session-watch-files");
const {
  handleCodexTuiLogLine,
  handleSessionRecord,
} = require("./codex-session-watch-handlers");

function consumeSessionFileUpdates(
  state,
  stat,
  {
    runtime,
    terminal,
    emittedEventKeys,
  }
) {
  consumeTailFileLines({
    state,
    stat,
    runtime,
    truncationLabel: "session file",
    onLine: (line) => {
      if (!line.trim()) {
        return;
      }
      handleSessionRecord(state, line, {
        runtime,
        terminal,
        emittedEventKeys,
      });
    },
  });
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

function pruneEmittedEventKeys(emittedEventKeys, maxSize) {
  while (emittedEventKeys.size > maxSize) {
    const firstKey = emittedEventKeys.keys().next();
    if (firstKey.done) {
      return;
    }
    emittedEventKeys.delete(firstKey.value);
  }
}

function consumeCodexTuiLogUpdates(
  state,
  stat,
  {
    runtime,
    terminal,
    emittedEventKeys,
  }
) {
  consumeTailFileLines({
    state,
    stat,
    runtime,
    truncationLabel: "tui log",
    onLine: (line) => {
      handleCodexTuiLogLine(line, {
        runtime,
        terminal,
        emittedEventKeys,
      });
    },
  });
}

function consumeTailFileLines({ state, stat, runtime, truncationLabel, onLine }) {
  if (stat.size < state.position) {
    runtime.log(
      `${truncationLabel} truncated file=${state.filePath} previous=${state.position} next=${stat.size}`
    );
    resetTailState(state, 0);
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
      onLine(line);
    });
  } finally {
    fs.closeSync(handle);
  }
}

function resetTailState(state, position) {
  state.position = position;
  state.partial = "";
  state.decoder = new StringDecoder("utf8");
}

module.exports = {
  consumeSessionFileUpdates,
  pruneEmittedEventKeys,
  syncCodexTuiLogState,
};
