const fs = require("fs");
const os = require("os");
const path = require("path");

const { parsePositiveInteger } = require("./shared-utils");

const TERMINAL_CONTEXT_STATE_DIR = path.join(
  os.tmpdir(),
  "ai-agent-notify",
  "codex-session-start"
);
const STALE_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function getTerminalContextStateDir() {
  return TERMINAL_CONTEXT_STATE_DIR;
}

function writeTerminalContextRecord(record) {
  const existing = readTerminalContextRecord(record && record.sessionId);
  const normalized = normalizeRecordForWrite(record, existing);
  fs.mkdirSync(TERMINAL_CONTEXT_STATE_DIR, { recursive: true });

  const recordPath = getTerminalContextRecordPath(normalized.sessionId);
  const tempPath = `${recordPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2), "utf8");
  fs.renameSync(tempPath, recordPath);

  return normalized;
}

function deleteTerminalContextRecord(sessionId) {
  const recordPath = getTerminalContextRecordPath(sessionId);
  if (!fs.existsSync(recordPath)) {
    return;
  }

  try {
    fs.unlinkSync(recordPath);
  } catch {}
}

function readAllTerminalContextRecords(log) {
  if (!fs.existsSync(TERMINAL_CONTEXT_STATE_DIR)) {
    return [];
  }

  let entries = [];
  try {
    entries = fs.readdirSync(TERMINAL_CONTEXT_STATE_DIR, { withFileTypes: true });
  } catch (error) {
    if (typeof log === "function") {
      log(
        `terminal-context state readdir failed dir=${TERMINAL_CONTEXT_STATE_DIR} error=${error.message}`
      );
    }
    return [];
  }

  const records = [];
  entries.forEach((entry) => {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
      return;
    }

    const recordPath = path.join(TERMINAL_CONTEXT_STATE_DIR, entry.name);
    try {
      const raw = fs.readFileSync(recordPath, "utf8");
      records.push(normalizeStoredRecord(JSON.parse(raw)));
    } catch (error) {
      if (typeof log === "function") {
        log(`terminal-context state parse failed file=${recordPath} error=${error.message}`);
      }
    }
  });

  return records;
}

function findTerminalContextForSession(sessionId, log) {
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedSessionId) {
    return null;
  }

  pruneStaleTerminalContextRecords(log);

  const record = readTerminalContextRecord(normalizedSessionId, log);
  if (!record) {
    return null;
  }

  const refreshed = writeTerminalContextRecord({
    ...record,
    lastMatchedAt: new Date().toISOString(),
  });

  return {
    sessionId: refreshed.sessionId,
    hwnd: refreshed.hwnd,
    shellPid: refreshed.shellPid,
    isWindowsTerminal: refreshed.isWindowsTerminal,
  };
}

function pruneStaleTerminalContextRecords(log) {
  const now = Date.now();
  readAllTerminalContextRecords(log).forEach((record) => {
    const referenceTimeMs = parseTime(record.lastMatchedAt || record.updatedAt || record.createdAt);
    if (!referenceTimeMs || now - referenceTimeMs > STALE_RECORD_MAX_AGE_MS) {
      deleteTerminalContextRecord(record.sessionId);
    }
  });
}

function readTerminalContextRecord(sessionId) {
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedSessionId) {
    return null;
  }

  const recordPath = getTerminalContextRecordPath(normalizedSessionId);
  if (!fs.existsSync(recordPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(recordPath, "utf8");
    return normalizeStoredRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function getTerminalContextRecordPath(sessionId) {
  const safeSessionId = String(sessionId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(TERMINAL_CONTEXT_STATE_DIR, `${safeSessionId}.json`);
}

function normalizeRecordForWrite(record, existingRecord) {
  const now = new Date().toISOString();
  const normalized = normalizeTerminalContextRecordShape(record);
  if (!normalized.sessionId) {
    throw new Error("terminal context record requires a sessionId");
  }

  normalized.createdAt = existingRecord?.createdAt || normalized.createdAt || now;
  normalized.updatedAt = now;
  normalized.lastMatchedAt =
    normalized.lastMatchedAt || existingRecord?.lastMatchedAt || "";
  return normalized;
}

function normalizeStoredRecord(record) {
  const normalized = normalizeTerminalContextRecordShape(record);
  normalized.createdAt = normalized.createdAt || normalized.updatedAt || normalized.lastMatchedAt || "";
  normalized.updatedAt = normalized.updatedAt || normalized.lastMatchedAt || normalized.createdAt || "";
  normalized.lastMatchedAt = normalized.lastMatchedAt || "";
  return normalized;
}

function normalizeTerminalContextRecordShape(record) {
  const source = record && typeof record === "object" ? record : {};

  return {
    kind: "codex-session-start",
    sessionId: typeof source.sessionId === "string" ? source.sessionId.trim() : "",
    hwnd: parsePositiveInteger(source.hwnd),
    shellPid: parsePositiveInteger(source.shellPid),
    isWindowsTerminal: source.isWindowsTerminal === true,
    createdAt: typeof source.createdAt === "string" ? source.createdAt : "",
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : "",
    lastMatchedAt: typeof source.lastMatchedAt === "string" ? source.lastMatchedAt : "",
  };
}

function parseTime(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = {
  deleteTerminalContextRecord,
  findTerminalContextForSession,
  getTerminalContextStateDir,
  parseTime,
  pruneStaleTerminalContextRecords,
  readAllTerminalContextRecords,
  writeTerminalContextRecord,
};
