const fs = require("fs");
const path = require("path");

const { isSameWindowsPath } = require("./windows-paths");

const SIDECAR_SESSION_RESOLUTION_POLL_MS = 1000;
const SIDECAR_SESSION_RESOLUTION_TIMEOUT_MS = 90 * 1000;
const SIDECAR_SESSION_RESOLUTION_MAX_PAST_MS = 30 * 1000;
const SIDECAR_SESSION_RESOLUTION_MAX_FUTURE_MS = 10 * 60 * 1000;

function startSidecarSessionResolver({
  getCurrentRecord,
  updateRecord,
  sessionsDir,
  log,
  findCandidate,
  pollMs = SIDECAR_SESSION_RESOLUTION_POLL_MS,
  timeoutMs = SIDECAR_SESSION_RESOLUTION_TIMEOUT_MS,
}) {
  let attempts = 0;
  let interval = null;
  let stopped = false;
  let resolveDone = () => {};
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const tick = () => {
    if (stopped) {
      return;
    }

    const currentRecord = getCurrentRecord();
    if (!currentRecord || currentRecord.sessionId) {
      stop();
      return;
    }

    attempts += 1;
    const candidate = findCandidate({
      cwd: currentRecord.cwd,
      sessionsDir,
      startedAtMs: Date.parse(currentRecord.startedAt),
      log,
    });

    if (candidate) {
      const resolvedAt = new Date().toISOString();
      updateRecord({
        ...currentRecord,
        sessionId: candidate.sessionId,
        resolvedAt,
      });
      log(
        `resolved mcp sidecar sessionId=${candidate.sessionId} file=${candidate.filePath} scoreMs=${candidate.score} reference=${candidate.referenceKind}`
      );
      stop();
      return;
    }

    if (attempts * pollMs >= timeoutMs) {
      log(`mcp sidecar session resolution timed out cwd=${currentRecord.cwd} timeoutMs=${timeoutMs}`);
      stop();
    }
  };

  interval = setInterval(tick, pollMs);
  tick();

  return {
    done,
    stop,
  };

  function stop() {
    if (stopped) {
      return;
    }
    stopped = true;
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    resolveDone();
  }
}

function resolveSidecarSessionCandidate({
  cwd,
  sessionsDir,
  startedAtMs,
  log,
  fileExistsCaseInsensitive,
  listRolloutFiles,
  readRolloutMetadata,
}) {
  if (
    !cwd ||
    !sessionsDir ||
    typeof fileExistsCaseInsensitive !== "function" ||
    typeof listRolloutFiles !== "function" ||
    typeof readRolloutMetadata !== "function" ||
    !fileExistsCaseInsensitive(sessionsDir)
  ) {
    return null;
  }

  const candidates = [];

  listRolloutFiles(sessionsDir, log).forEach((filePath) => {
    const rolloutStartedAtMs = parseRolloutTimestampFromPath(filePath);
    let stat = null;

    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }

    const metadata = readRolloutMetadata(filePath, log);
    if (!metadata.sessionId || !isSameWindowsPath(metadata.cwd, cwd)) {
      return;
    }

    const reference = pickBestSidecarCandidateReference(
      [
        {
          kind: "latest_event",
          timestampMs: metadata.latestEventAtMs,
        },
        {
          kind: "mtime",
          timestampMs: stat.mtimeMs,
        },
        {
          kind: "rollout_start",
          timestampMs: rolloutStartedAtMs,
        },
      ],
      startedAtMs
    );
    if (!reference) {
      return;
    }

    candidates.push({
      filePath,
      sessionId: metadata.sessionId,
      score: reference.score,
      isFutureMatch: reference.signedDistanceMs >= 0,
      referenceStartedAtMs: reference.timestampMs,
      referenceKind: reference.kind,
    });
  });

  return pickSidecarSessionCandidate(candidates);
}

function pickBestSidecarCandidateReference(references, startedAtMs) {
  if (!Array.isArray(references) || !startedAtMs) {
    return null;
  }

  const priority = {
    latest_event: 3,
    mtime: 2,
    rollout_start: 1,
  };

  const candidates = references
    .filter(
      (reference) =>
        reference &&
        reference.timestampMs &&
        isSidecarResolutionTimeMatch({
          candidateStartedAtMs: reference.timestampMs,
          sidecarStartedAtMs: startedAtMs,
        })
    )
    .map((reference) => ({
      kind: reference.kind,
      timestampMs: reference.timestampMs,
      signedDistanceMs: reference.timestampMs - startedAtMs,
      score: Math.abs(reference.timestampMs - startedAtMs),
      priority: priority[reference.kind] || 0,
    }))
    .sort(
      (left, right) =>
        left.score - right.score ||
        right.priority - left.priority ||
        Number(right.signedDistanceMs >= 0) - Number(left.signedDistanceMs >= 0)
    );

  return candidates[0] || null;
}

function pickSidecarSessionCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const sorted = candidates
    .slice()
    .sort(
      (left, right) =>
        left.score - right.score ||
        Number(right.isFutureMatch === true) - Number(left.isFutureMatch === true) ||
        right.referenceStartedAtMs - left.referenceStartedAtMs ||
        left.sessionId.localeCompare(right.sessionId)
    );

  const best = sorted[0];
  const second = sorted[1];
  if (!best || best.score > 2 * 60 * 1000) {
    return null;
  }

  if (
    second &&
    Math.abs(best.score - second.score) < 3000 &&
    (best.isFutureMatch === second.isFutureMatch || best.isFutureMatch !== true)
  ) {
    return null;
  }

  return best;
}

function isSidecarResolutionTimeMatch({ candidateStartedAtMs, sidecarStartedAtMs }) {
  if (!candidateStartedAtMs || !sidecarStartedAtMs) {
    return false;
  }

  const signedDistanceMs = candidateStartedAtMs - sidecarStartedAtMs;
  return (
    signedDistanceMs >= -SIDECAR_SESSION_RESOLUTION_MAX_PAST_MS &&
    signedDistanceMs <= SIDECAR_SESSION_RESOLUTION_MAX_FUTURE_MS
  );
}

function parseRolloutTimestampFromPath(filePath) {
  const match = path
    .basename(filePath)
    .match(/^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-.+\.jsonl$/i);

  if (!match) {
    return 0;
  }

  const [, datePart, hourPart, minutePart, secondPart] = match;
  const parsed = new Date(`${datePart}T${hourPart}:${minutePart}:${secondPart}`).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = {
  parseRolloutTimestampFromPath,
  pickSidecarSessionCandidate,
  resolveSidecarSessionCandidate,
  startSidecarSessionResolver,
};
