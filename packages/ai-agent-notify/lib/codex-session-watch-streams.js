const fs = require("fs");
const { StringDecoder } = require("string_decoder");

const { handleSessionRecord } = require("./codex-session-watch-handlers");

function consumeSessionFileUpdates(
  state,
  stat,
  {
    runtime,
    terminal,
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
};
