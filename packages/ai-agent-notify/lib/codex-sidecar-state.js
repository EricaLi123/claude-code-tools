const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  countCommonSegments,
  normalizeWindowsPath,
  splitWindowsPath,
} = require("./windows-paths");

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

function findSidecarTerminalContextForSession(sessionId, log) {
  if (!sessionId) {
    return null;
  }

  pruneStaleSidecarRecords(log);

  const matches = readAllSidecarRecords(log)
    .filter((record) => record.sessionId === sessionId)
    .sort(compareRecordsByFreshness);

  if (matches.length === 0) {
    return null;
  }

  const match = writeSidecarRecord({
    ...matches[0],
    lastMatchedAt: new Date().toISOString(),
  });
  return {
    recordId: match.recordId,
    cwd: match.cwd || "",
    hwnd: parsePositiveInteger(match.hwnd),
    shellPid: parsePositiveInteger(match.shellPid),
    isWindowsTerminal: match.isWindowsTerminal === true,
    sessionId: match.sessionId,
  };
}

function findSidecarTerminalContextForProjectDir(projectDir, log) {
  if (!projectDir) {
    return null;
  }

  pruneStaleSidecarRecords(log);

  const matches = readAllSidecarRecords(log)
    .map((record) => ({
      record,
      match: describeProjectDirMatch(record.cwd, projectDir),
    }))
    .filter(
      (entry) =>
        entry.match &&
        !entry.record.sessionId &&
        parsePositiveInteger(entry.record.hwnd) &&
        isProcessAlive(entry.record.pid)
    )
    .sort(compareProjectDirFallbackCandidates);

  if (matches.length === 0) {
    return null;
  }

  const best = matches[0];
  const second = matches[1];
  if (
    second &&
    best.match.relationPriority === second.match.relationPriority &&
    best.match.distance === second.match.distance &&
    best.match.commonSegments === second.match.commonSegments
  ) {
    return null;
  }

  if (typeof log === "function") {
    log(
      `sidecar cwd fallback matched projectDir=${projectDir} recordCwd=${best.record.cwd || ""} hwnd=${best.record.hwnd || ""} pid=${best.record.pid || ""}`
    );
  }

  return {
    recordId: best.record.recordId,
    cwd: best.record.cwd || "",
    hwnd: parsePositiveInteger(best.record.hwnd),
    shellPid: null,
    isWindowsTerminal: false,
    sessionId: "",
  };
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

function compareRecordsByFreshness(left, right) {
  return (
    parseTime(right.resolvedAt) - parseTime(left.resolvedAt) ||
    parseTime(right.updatedAt) - parseTime(left.updatedAt) ||
    parseTime(right.startedAt) - parseTime(left.startedAt)
  );
}

function parsePositiveInteger(value) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseTime(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function isProcessAlive(pid) {
  const normalizedPid = parsePositiveInteger(pid);
  if (!normalizedPid) {
    return false;
  }

  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function describeProjectDirMatch(recordCwd, projectDir) {
  const normalizedRecord = normalizeWindowsPath(recordCwd);
  const normalizedProject = normalizeWindowsPath(projectDir);
  if (!normalizedRecord || !normalizedProject) {
    return null;
  }

  const recordSegments = splitWindowsPath(normalizedRecord);
  const projectSegments = splitWindowsPath(normalizedProject);
  const commonSegments = countCommonSegments(recordSegments, projectSegments);

  if (normalizedRecord === normalizedProject) {
    return {
      relation: "exact",
      relationPriority: 3,
      distance: 0,
      commonSegments,
    };
  }

  if (normalizedRecord.startsWith(`${normalizedProject}\\`)) {
    return {
      relation: "record_inside_project",
      relationPriority: 2,
      distance: Math.max(0, recordSegments.length - projectSegments.length),
      commonSegments,
    };
  }

  if (normalizedProject.startsWith(`${normalizedRecord}\\`)) {
    return {
      relation: "project_inside_record",
      relationPriority: 1,
      distance: Math.max(0, projectSegments.length - recordSegments.length),
      commonSegments,
    };
  }

  return null;
}

function compareProjectDirFallbackCandidates(left, right) {
  return (
    right.match.relationPriority - left.match.relationPriority ||
    left.match.distance - right.match.distance ||
    right.match.commonSegments - left.match.commonSegments ||
    parseTime(right.record.updatedAt) - parseTime(left.record.updatedAt) ||
    parseTime(right.record.startedAt) - parseTime(left.record.startedAt)
  );
}

module.exports = {
  deleteSidecarRecord,
  findSidecarTerminalContextForProjectDir,
  findSidecarTerminalContextForSession,
  getSidecarStateDir,
  pruneStaleSidecarRecords,
  writeSidecarRecord,
};
