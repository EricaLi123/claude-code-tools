"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { LOG_DIR } = require("./notify-runtime");

const CODEX_EVENT_RECONCILIATION_TTL_MS = 10 * 60 * 1000;
const SUPPORTED_EVENT_NAMES = new Set(["PermissionRequest", "Stop"]);

function shouldEmitCodexEventNotification(
  notification,
  { runtime, reconciliationsDir, nowMs = Date.now() } = {}
) {
  const key = buildCodexEventReconciliationKey(notification);
  if (!key || !isCodexReconciliationNotification(notification)) {
    return true;
  }

  const pathKey = buildCodexEventPathKey(notification);

  try {
    pruneExpiredCodexEventReconciliations({ reconciliationsDir, nowMs });

    const recordPath = getCodexEventReconciliationPath(key, reconciliationsDir);
    const record = readCodexEventReconciliationRecord(recordPath);
    const existingPaths = record && record.paths ? record.paths : {};
    const hasCurrentPath = !!existingPaths[pathKey];
    const matchedPathKeys = Object.keys(existingPaths).filter((candidate) => candidate !== pathKey);
    const nextRecord = buildNextCodexEventReconciliationRecord({
      notification,
      key,
      nowMs,
      pathKey,
      record,
    });

    writeCodexEventReconciliationRecord(recordPath, nextRecord);

    if (hasCurrentPath) {
      logParallelReconciliation(
        runtime,
        `parallel reconciliation repeated key=${key} path=${pathKey} action=skip`
      );
      return false;
    }

    if (matchedPathKeys.length > 0) {
      logParallelReconciliation(
        runtime,
        `parallel reconciliation matched key=${key} path=${pathKey} matched=${matchedPathKeys.join(",")} action=skip`
      );
      return false;
    }

    logParallelReconciliation(
      runtime,
      `parallel reconciliation recorded key=${key} path=${pathKey} action=emit`
    );
    return true;
  } catch (error) {
    logParallelReconciliation(
      runtime,
      `parallel reconciliation failed key=${key} path=${pathKey} error=${error.message}`
    );
    return true;
  }
}

function buildCodexEventReconciliationKey({ sessionId, turnId, eventName } = {}) {
  if (
    !sessionId ||
    sessionId === "unknown" ||
    !turnId ||
    !SUPPORTED_EVENT_NAMES.has(eventName || "")
  ) {
    return "";
  }

  return `${sessionId}|${turnId}|${eventName}`;
}

function pruneExpiredCodexEventReconciliations({ reconciliationsDir, nowMs = Date.now() } = {}) {
  const targetDir = getCodexEventReconciliationDir(reconciliationsDir);
  if (!fs.existsSync(targetDir)) {
    return 0;
  }

  let removed = 0;
  let entries = [];

  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  entries.forEach((entry) => {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
      return;
    }

    const recordPath = path.join(targetDir, entry.name);

    try {
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      if (
        !record ||
        typeof record.key !== "string" ||
        !record.key ||
        typeof record.expiresAtMs !== "number" ||
        record.expiresAtMs <= nowMs
      ) {
        deleteReconciliationFile(recordPath);
        removed += 1;
      }
    } catch {
      deleteReconciliationFile(recordPath);
      removed += 1;
    }
  });

  return removed;
}

function getCodexEventReconciliationDir(reconciliationsDir) {
  return reconciliationsDir || path.join(LOG_DIR, "codex-event-reconciliation");
}

function getCodexEventReconciliationPath(key, reconciliationsDir) {
  const hash = crypto.createHash("sha1").update(key).digest("hex");
  return path.join(getCodexEventReconciliationDir(reconciliationsDir), `${hash}.json`);
}

function buildCodexEventPathKey(notification) {
  return `${notification.agentId || "unknown"}|${notification.entryPointId || "unknown"}`;
}

function buildNextCodexEventReconciliationRecord({ notification, key, nowMs, pathKey, record }) {
  const existingPaths = record && record.paths ? record.paths : {};
  const existingPathRecord = existingPaths[pathKey] || null;

  return {
    key,
    sessionId: notification.sessionId,
    turnId: notification.turnId,
    eventName: notification.eventName,
    firstSeenAtMs:
      record && typeof record.firstSeenAtMs === "number" ? record.firstSeenAtMs : nowMs,
    lastSeenAtMs: nowMs,
    expiresAtMs: nowMs + CODEX_EVENT_RECONCILIATION_TTL_MS,
    paths: {
      ...existingPaths,
      [pathKey]: {
        agentId: notification.agentId || "",
        entryPointId: notification.entryPointId || "",
        projectDir: notification.projectDir || "",
        rawEventType: notification.rawEventType || "",
        transport: notification.transport || "",
        title: notification.title || "",
        message: notification.message || "",
        firstSeenAtMs:
          existingPathRecord && typeof existingPathRecord.firstSeenAtMs === "number"
            ? existingPathRecord.firstSeenAtMs
            : nowMs,
        lastSeenAtMs: nowMs,
      },
    },
  };
}

function writeCodexEventReconciliationRecord(recordPath, record) {
  const targetDir = path.dirname(recordPath);
  const tempPath = `${recordPath}.tmp-${process.pid}-${Date.now()}`;

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(record), "utf8");
  fs.renameSync(tempPath, recordPath);
}

function readCodexEventReconciliationRecord(recordPath) {
  if (!fs.existsSync(recordPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch {
    deleteReconciliationFile(recordPath);
    return null;
  }
}

function deleteReconciliationFile(recordPath) {
  try {
    fs.unlinkSync(recordPath);
  } catch {}
}

function isCodexReconciliationNotification(notification) {
  if (!notification) {
    return false;
  }

  return notification.agentId === "codex";
}

function logParallelReconciliation(runtime, message) {
  if (runtime && typeof runtime.log === "function") {
    runtime.log(message);
  }
}

module.exports = {
  CODEX_EVENT_RECONCILIATION_TTL_MS,
  buildCodexEventReconciliationKey,
  getCodexEventReconciliationDir,
  getCodexEventReconciliationPath,
  pruneExpiredCodexEventReconciliations,
  shouldEmitCodexEventNotification,
};
