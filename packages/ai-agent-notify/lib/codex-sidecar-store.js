const fs = require("fs");
const os = require("os");
const path = require("path");

const { parsePositiveInteger } = require("./shared-utils");

const SIDECAR_STATE_DIR = path.join(os.tmpdir(), "ai-agent-notify", "codex-mcp-sidecar");
const STALE_UNRESOLVED_RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_RESOLVED_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function getSidecarStateDir() {
  return SIDECAR_STATE_DIR;
}

function writeSidecarRecord(record) {
  const normalized = normalizeRecord(record);
  fs.mkdirSync(SIDECAR_STATE_DIR, { recursive: true });

  const recordPath = getSidecarRecordPath(normalized.recordId);
  const tempPath = `${recordPath}.tmp-${process.pid}`;

  fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2), "utf8");
  fs.renameSync(tempPath, recordPath);

  return normalized;
}

function deleteSidecarRecord(recordId) {
  const recordPath = getSidecarRecordPath(recordId);
  if (!fs.existsSync(recordPath)) {
    return;
  }

  try {
    fs.unlinkSync(recordPath);
  } catch {}
}

function readAllSidecarRecords(log) {
  if (!fs.existsSync(SIDECAR_STATE_DIR)) {
    return [];
  }

  let entries = [];
  try {
    entries = fs.readdirSync(SIDECAR_STATE_DIR, { withFileTypes: true });
  } catch (error) {
    if (typeof log === "function") {
      log(`sidecar state readdir failed dir=${SIDECAR_STATE_DIR} error=${error.message}`);
    }
    return [];
  }

  const records = [];
  entries.forEach((entry) => {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
      return;
    }

    const recordPath = path.join(SIDECAR_STATE_DIR, entry.name);
    try {
      const raw = fs.readFileSync(recordPath, "utf8");
      records.push(normalizeRecord(JSON.parse(raw)));
    } catch (error) {
      if (typeof log === "function") {
        log(`sidecar state parse failed file=${recordPath} error=${error.message}`);
      }
    }
  });

  return records;
}

function pruneStaleSidecarRecords(log) {
  const now = Date.now();
  readAllSidecarRecords(log).forEach((record) => {
    const referenceTimeMs = parseTime(
      record.lastMatchedAt || record.updatedAt || record.resolvedAt || record.startedAt
    );
    const maxAgeMs = record.sessionId
      ? STALE_RESOLVED_RECORD_MAX_AGE_MS
      : STALE_UNRESOLVED_RECORD_MAX_AGE_MS;
    const isTooOld = !referenceTimeMs || now - referenceTimeMs > maxAgeMs;
    if (isTooOld) {
      deleteSidecarRecord(record.recordId);
    }
  });
}

function getSidecarRecordPath(recordId) {
  const safeId = String(recordId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(SIDECAR_STATE_DIR, `${safeId}.json`);
}

function normalizeRecord(record) {
  const now = new Date().toISOString();
  const normalized = record && typeof record === "object" ? { ...record } : {};

  normalized.recordId = String(normalized.recordId || `${process.pid}`);
  normalized.kind = "codex-mcp-sidecar";
  normalized.pid = parsePositiveInteger(normalized.pid);
  normalized.parentPid = parsePositiveInteger(normalized.parentPid);
  normalized.hwnd = parsePositiveInteger(normalized.hwnd);
  normalized.shellPid = parsePositiveInteger(normalized.shellPid);
  normalized.isWindowsTerminal = normalized.isWindowsTerminal === true;
  normalized.cwd = typeof normalized.cwd === "string" ? normalized.cwd : "";
  normalized.sessionId = typeof normalized.sessionId === "string" ? normalized.sessionId : "";
  normalized.startedAt = typeof normalized.startedAt === "string" ? normalized.startedAt : now;
  normalized.updatedAt = now;
  normalized.resolvedAt =
    typeof normalized.resolvedAt === "string" ? normalized.resolvedAt : "";
  normalized.lastMatchedAt =
    typeof normalized.lastMatchedAt === "string" ? normalized.lastMatchedAt : "";

  return normalized;
}

function parseTime(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = {
  deleteSidecarRecord,
  getSidecarStateDir,
  parseTime,
  pruneStaleSidecarRecords,
  readAllSidecarRecords,
  writeSidecarRecord,
};
