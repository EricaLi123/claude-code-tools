"use strict";

function createNotificationSpec(spec) {
  const sourceId = canonicalizeSourceId(spec.sourceId || "unknown");
  const entryPointId = canonicalizeEntryPointId(spec.entryPointId || "");
  const eventName = spec.eventName || "";

  return {
    sourceId,
    entryPointId,
    sourceFamily: getSourceFamily(sourceId),
    source: canonicalizeDisplaySource(spec.source) || inferDisplaySource(sourceId, entryPointId),
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
    source: canonicalizeDisplaySource(overrides.source || spec.source),
    title: canonicalizeNotificationTitle(overrides.title || spec.title),
    message: canonicalizeNotificationMessage(overrides.message || spec.message),
  };
}

function getExplicitDisplayOverrides(env) {
  return {
    source: getStringField(env, ["TOAST_NOTIFY_SOURCE"]),
    title: getStringField(env, ["TOAST_NOTIFY_TITLE"]),
    message: getStringField(env, ["TOAST_NOTIFY_MESSAGE"]),
  };
}

function inferDisplaySource(sourceId, entryPointId) {
  if (!sourceId || sourceId === "unknown") {
    return "";
  }

  return entryPointId ? `${sourceId}.${entryPointId}` : sourceId;
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

function canonicalizeDisplaySource(source) {
  const trimmed = typeof source === "string" ? source.trim() : "";
  if (!trimmed) {
    return "";
  }

  if (/^(unknown|notification)$/i.test(trimmed)) {
    return "";
  }

  return trimmed;
}

function canonicalizeSourceId(sourceId) {
  const trimmed = typeof sourceId === "string" ? sourceId.trim() : "";
  if (!trimmed || /^(unknown|notification)$/i.test(trimmed)) {
    return "unknown";
  }

  return trimmed.toLowerCase();
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

function getSourceFamily(sourceId) {
  if (sourceId === "codex") {
    return "codex";
  }

  if (sourceId === "claude") {
    return "claude";
  }

  return "generic";
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
  createNotificationSpec,
  getExplicitDisplayOverrides,
  getSourceFamily,
};
