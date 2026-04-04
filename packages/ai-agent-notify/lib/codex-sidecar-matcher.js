const { parsePositiveInteger } = require("./shared-utils");
const {
  countCommonSegments,
  normalizeWindowsPath,
  splitWindowsPath,
} = require("./windows-paths");
const {
  parseTime,
  pruneStaleSidecarRecords,
  readAllSidecarRecords,
  writeSidecarRecord,
} = require("./codex-sidecar-store");

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

function compareRecordsByFreshness(left, right) {
  return (
    parseTime(right.resolvedAt) - parseTime(left.resolvedAt) ||
    parseTime(right.updatedAt) - parseTime(left.updatedAt) ||
    parseTime(right.startedAt) - parseTime(left.startedAt)
  );
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
  findSidecarTerminalContextForProjectDir,
  findSidecarTerminalContextForSession,
};
