const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { LOG_DIR } = require("./notify-runtime");

const CODEX_COMPLETION_RECEIPT_TTL_MS = 10 * 60 * 1000;

function buildCodexCompletionReceiptKey({ sessionId, turnId, eventName = "Stop" } = {}) {
  if (!sessionId || sessionId === "unknown" || !turnId || eventName !== "Stop") {
    return "";
  }

  return `${sessionId}|${turnId}|Stop`;
}

function hasCodexCompletionReceipt({
  sessionId,
  turnId,
  eventName = "Stop",
  receiptsDir,
  nowMs = Date.now(),
} = {}) {
  const key = buildCodexCompletionReceiptKey({ sessionId, turnId, eventName });
  if (!key) {
    return false;
  }

  const receiptPath = getCodexCompletionReceiptPath(key, receiptsDir);
  if (!fs.existsSync(receiptPath)) {
    return false;
  }

  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (
      !receipt ||
      receipt.key !== key ||
      receipt.sessionId !== sessionId ||
      receipt.turnId !== turnId ||
      receipt.eventName !== "Stop" ||
      typeof receipt.expiresAtMs !== "number" ||
      receipt.expiresAtMs <= nowMs
    ) {
      deleteReceiptFile(receiptPath);
      return false;
    }

    return true;
  } catch {
    deleteReceiptFile(receiptPath);
    return false;
  }
}

function pruneExpiredCodexCompletionReceipts({ receiptsDir, nowMs = Date.now() } = {}) {
  const targetDir = getCodexCompletionReceiptDir(receiptsDir);
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

    const receiptPath = path.join(targetDir, entry.name);

    try {
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      if (
        !receipt ||
        typeof receipt.expiresAtMs !== "number" ||
        receipt.expiresAtMs <= nowMs ||
        typeof receipt.key !== "string" ||
        !receipt.key
      ) {
        deleteReceiptFile(receiptPath);
        removed += 1;
      }
    } catch {
      deleteReceiptFile(receiptPath);
      removed += 1;
    }
  });

  return removed;
}

function writeCodexCompletionReceipt({
  runtime,
  sessionId,
  turnId,
  eventName = "Stop",
  receiptsDir,
  nowMs = Date.now(),
} = {}) {
  const key = buildCodexCompletionReceiptKey({ sessionId, turnId, eventName });
  if (!key) {
    return false;
  }

  try {
    pruneExpiredCodexCompletionReceipts({ receiptsDir, nowMs });

    const receiptPath = getCodexCompletionReceiptPath(key, receiptsDir);
    const receiptDir = path.dirname(receiptPath);
    const receipt = {
      key,
      sessionId,
      turnId,
      eventName: "Stop",
      expiresAtMs: nowMs + CODEX_COMPLETION_RECEIPT_TTL_MS,
    };
    const tempPath = `${receiptPath}.tmp-${process.pid}-${Date.now()}`;

    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(receipt), "utf8");
    fs.renameSync(tempPath, receiptPath);

    if (runtime && typeof runtime.log === "function") {
      runtime.log(`wrote completion receipt sessionId=${sessionId} turnId=${turnId} eventName=Stop`);
    }

    return true;
  } catch (error) {
    if (runtime && typeof runtime.log === "function") {
      runtime.log(
        `failed to write completion receipt sessionId=${sessionId || "unknown"} turnId=${turnId || ""} error=${error.message}`
      );
    }
    return false;
  }
}

function writeCodexCompletionReceiptForNotification(
  notification,
  { runtime, receiptsDir, nowMs = Date.now() } = {}
) {
  if (
    !notification ||
    notification.sourceId !== "codex" ||
    notification.entryPointId !== "notify-mode" ||
    notification.eventName !== "Stop"
  ) {
    return false;
  }

  return writeCodexCompletionReceipt({
    runtime,
    sessionId: notification.sessionId,
    turnId: notification.turnId,
    eventName: notification.eventName,
    receiptsDir,
    nowMs,
  });
}

function getCodexCompletionReceiptDir(receiptsDir) {
  return receiptsDir || path.join(LOG_DIR, "completion-receipts");
}

function getCodexCompletionReceiptPath(key, receiptsDir) {
  const hash = crypto.createHash("sha1").update(key).digest("hex");
  return path.join(getCodexCompletionReceiptDir(receiptsDir), `${hash}.json`);
}

function deleteReceiptFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

module.exports = {
  CODEX_COMPLETION_RECEIPT_TTL_MS,
  buildCodexCompletionReceiptKey,
  hasCodexCompletionReceipt,
  pruneExpiredCodexCompletionReceipts,
  writeCodexCompletionReceipt,
  writeCodexCompletionReceiptForNotification,
};
