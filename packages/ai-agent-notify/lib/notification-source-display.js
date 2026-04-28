"use strict";

function createNotificationSpec(spec) {
  const agentId = canonicalizeAgentId(spec.agentId || "unknown");
  const entryPointId = canonicalizeEntryPointId(spec.entryPointId || "");
  const eventName = spec.eventName || "";

  return {
    agentId,
    entryPointId,
    transport: spec.transport || "",
    sessionId: spec.sessionId || "unknown",
    turnId: spec.turnId || "",
    eventName,
    title: canonicalizeNotificationTitle(spec.title || inferNotificationTitle(eventName)),
    message: canonicalizeNotificationMessage(spec.message || inferNotificationMessage(eventName)),
    projectDir: spec.projectDir || "",
    rawEventType: spec.rawEventType || "",
    payloadKeys: Array.isArray(spec.payloadKeys) ? spec.payloadKeys : [],
    client: spec.client || "",
    debugSummary: spec.debugSummary || "",
  };
}

function applyExplicitDisplayOverrides(spec, overrides) {
  return {
    ...spec,
    title: canonicalizeNotificationTitle(overrides.title || spec.title),
    message: canonicalizeNotificationMessage(overrides.message || spec.message),
  };
}

function getExplicitDisplayOverrides(env) {
  return {
    title: getStringField(env, ["TOAST_NOTIFY_TITLE"]),
    message: getStringField(env, ["TOAST_NOTIFY_MESSAGE"]),
  };
}

function inferNotificationTitle(eventName) {
  switch (eventName) {
    case "Stop":
      return "Done";
    case "PermissionRequest":
      return "Needs Approval";
    case "InputRequest":
      return "Input Needed";
    default:
      return "Notification";
  }
}

function inferNotificationMessage(eventName) {
  switch (eventName) {
    case "Stop":
      return "Task finished";
    case "PermissionRequest":
      return "Waiting for your approval";
    case "InputRequest":
      return "Waiting for your input";
    default:
      return "Notification";
  }
}

function canonicalizeAgentId(agentId) {
  const trimmed = typeof agentId === "string" ? agentId.trim() : "";
  if (!trimmed || /^(unknown|notification)$/i.test(trimmed)) {
    return "unknown";
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "codex" || normalized.startsWith("codex-") || normalized.startsWith("codex.")) {
    return "codex";
  }

  if (
    normalized === "claude" ||
    normalized.startsWith("claude-") ||
    normalized.startsWith("claude.")
  ) {
    return "claude";
  }

  return "unknown";
}

function canonicalizeEntryPointId(entryPointId) {
  const trimmed = typeof entryPointId === "string" ? entryPointId.trim() : "";
  if (!trimmed || /^(unknown|notification)$/i.test(trimmed)) {
    return "";
  }

  return trimmed.toLowerCase();
}

function canonicalizeNotificationTitle(title) {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (!trimmed) {
    return "Notification";
  }

  return trimmed
    .replace(/^\[(Claude|Codex|Agent)\]\s*/i, "")
    .replace(/Needs Permission/g, "Needs Approval")
    .replace(/^(Claude|Codex|Agent)\s+Needs Approval$/i, "Needs Approval")
    .replace(/^(Claude|Codex|Agent)\s+Input Needed$/i, "Input Needed")
    .replace(/^(Claude|Codex|Agent)\s+Done$/i, "Done")
    .replace(/^(Claude|Codex|Agent)$/i, "Notification");
}

function canonicalizeNotificationMessage(message) {
  const trimmed = typeof message === "string" ? message.trim() : "";
  return trimmed || "Notification";
}

function getStringField(payload, keys) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

module.exports = {
  applyExplicitDisplayOverrides,
  canonicalizeAgentId,
  createNotificationSpec,
  getExplicitDisplayOverrides,
};
