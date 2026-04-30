const fs = require("fs");
const path = require("path");
const { StringDecoder } = require("string_decoder");

const { parseSessionIdFromRolloutPath } = require("./codex-session-event-descriptors");
const { fileExistsCaseInsensitive } = require("./shared-utils");

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

function bootstrapExistingSessionFileState(state, stat) {
  bootstrapTailFileState(state, stat);
}

function bootstrapTailFileState(state, stat) {
  state.position = stat.size;
  state.partial = "";
  state.decoder = new StringDecoder("utf8");
}

module.exports = {
  bootstrapExistingSessionFileState,
  bootstrapTailFileState,
  createSessionFileState,
  createTailFileState,
  listRolloutFiles,
};
