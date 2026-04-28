const fs = require("fs");
const path = require("path");
const { StringDecoder } = require("string_decoder");

const { parseSessionIdFromRolloutPath } = require("./codex-session-event-descriptors");
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

module.exports = {
  bootstrapExistingSessionFileState,
  bootstrapTailFileState,
  createSessionFileState,
  createTailFileState,
  listRolloutFiles,
  readRolloutMetadata,
};
