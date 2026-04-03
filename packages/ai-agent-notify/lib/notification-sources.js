"use strict";

const CODEX_EVENT_NAME_BY_TYPE = {
  "agent-turn-complete": "Stop",
  "approval-requested": "PermissionRequest",
  "exec-approval-request": "PermissionRequest",
  "request-permissions": "PermissionRequest",
  "apply-patch-approval-request": "PermissionRequest",
  "request-user-input": "InputRequest",
};

function normalizeIncomingNotification({ argv = [], stdinData = "", env = {} } = {}) {
  const candidates = getIncomingPayloadCandidates(argv, stdinData, env);
  const explicitOverrides = getExplicitDisplayOverrides(env);

  for (const candidate of candidates) {
    const normalized =
      normalizeClaudeHookPayload(candidate) ||
      normalizeCodexLegacyNotifyPayload(candidate) ||
      normalizeGenericJsonPayload(candidate);

    if (normalized) {
      return applyExplicitDisplayOverrides(normalized, explicitOverrides);
    }
  }

  return applyExplicitDisplayOverrides(
    createNotificationSpec({
      sourceId: "unknown",
      transport: candidates.length > 0 ? candidates[0].transport : "none",
      sessionId: "unknown",
      payloadKeys: [],
      debugSummary:
        candidates.length > 0 ? buildCandidateSummary(candidates[0]) : "payload transport=none",
    }),
    explicitOverrides
  );
}

function getIncomingPayloadCandidates(argv, stdinData, env) {
  const candidates = [];

  pushPayloadCandidate(candidates, {
    transport: "stdin",
    raw: stdinData,
    acceptNonJson: true,
  });

  for (let index = argv.length - 1; index >= 0; index -= 1) {
    pushPayloadCandidate(candidates, {
      transport: `argv[${index}]`,
      raw: argv[index],
      acceptNonJson: false,
    });
  }

  return dedupePayloadCandidates(candidates);
}

function pushPayloadCandidate(candidates, { transport, raw, acceptNonJson }) {
  const trimmed = normalizePayloadString(raw);
  if (!trimmed) {
    return;
  }

  if (!acceptNonJson && !looksLikeJson(trimmed)) {
    return;
  }

  const parsed = parseJsonMaybe(trimmed);
  candidates.push({
    transport,
    raw: trimmed,
    parsed,
    parseState: describeParsedValue(parsed),
  });
}

function dedupePayloadCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.transport}:${candidate.raw}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeClaudeHookPayload(candidate) {
  const payload = candidate.parsed;
  if (!isPlainObject(payload)) {
    return null;
  }

  if (!hasAnyKey(payload, ["hook_event_name", "session_id", "title", "message", "source"])) {
    return null;
  }

  return createNotificationSpec({
    sourceId: "claude-hook",
    source: getStringField(payload, ["source"]),
    transport: candidate.transport,
    sessionId: getStringField(payload, ["session_id"]) || "unknown",
    eventName: getStringField(payload, ["hook_event_name"]),
    title: getStringField(payload, ["title"]),
    message: getStringField(payload, ["message"]),
    rawEventType: getStringField(payload, ["hook_event_name"]),
    payloadKeys: Object.keys(payload).sort(),
    debugSummary: buildCandidateSummary(candidate),
  });
}

function normalizeCodexLegacyNotifyPayload(candidate) {
  const payload = candidate.parsed;
  if (!isPlainObject(payload)) {
    return null;
  }

  const rawEventType = getStringField(payload, ["type"]);
  const sessionId =
    getStringField(payload, ["thread-id", "thread_id", "threadId"]) ||
    getStringField(payload, ["turn-id", "turn_id", "turnId"]) ||
    "unknown";
  const turnId = getStringField(payload, ["turn-id", "turn_id", "turnId"]);
  const client = getStringField(payload, ["client"]);
  const projectDir = getStringField(payload, ["cwd", "project-dir", "project_dir", "projectDir"]);
  const hasCodexShape =
    !!rawEventType &&
    (client.startsWith("codex") ||
      hasAnyKey(payload, [
        "thread-id",
        "thread_id",
        "threadId",
        "turn-id",
        "turn_id",
        "turnId",
        "cwd",
        "input-messages",
        "input_messages",
        "last-assistant-message",
        "last_assistant_message",
      ]));

  if (!hasCodexShape) {
    return null;
  }

  return createNotificationSpec({
    sourceId: "codex-legacy-notify",
    source: getStringField(payload, ["source"]),
    transport: candidate.transport,
    sessionId,
    turnId,
    eventName: CODEX_EVENT_NAME_BY_TYPE[rawEventType] || "",
    title: getStringField(payload, ["title"]),
    message: getStringField(payload, ["message"]),
    projectDir,
    rawEventType,
    client,
    payloadKeys: Object.keys(payload).sort(),
    debugSummary: buildCandidateSummary(candidate),
  });
}

function normalizeGenericJsonPayload(candidate) {
  const payload = candidate.parsed;
  if (!isPlainObject(payload)) {
    return null;
  }

  return createNotificationSpec({
    sourceId: inferSourceId(payload),
    source: getStringField(payload, ["source"]),
    transport: candidate.transport,
    sessionId:
      getStringField(payload, ["session_id", "thread-id", "thread_id", "threadId"]) || "unknown",
    eventName: getStringField(payload, ["hook_event_name", "event", "type"]),
    title: getStringField(payload, ["title"]),
    message: getStringField(payload, ["message"]),
    projectDir: getStringField(payload, ["cwd", "project-dir", "project_dir", "projectDir"]),
    rawEventType: getStringField(payload, ["type"]),
    client: getStringField(payload, ["client"]),
    payloadKeys: Object.keys(payload).sort(),
    debugSummary: buildCandidateSummary(candidate),
  });
}

function inferSourceId(payload) {
  const client = getStringField(payload, ["client"]);
  if (client.startsWith("codex")) {
    return "codex-json";
  }

  if (
    hasAnyKey(payload, [
      "thread-id",
      "thread_id",
      "threadId",
      "turn-id",
      "turn_id",
      "turnId",
      "input-messages",
      "input_messages",
      "last-assistant-message",
      "last_assistant_message",
    ])
  ) {
    return "codex-json";
  }

  if (hasAnyKey(payload, ["hook_event_name", "session_id"])) {
    return "claude-hook";
  }

  return "unknown";
}

function createNotificationSpec(spec) {
  const sourceId = spec.sourceId || spec.source || "unknown";
  const eventName = spec.eventName || "";

  return {
    sourceId,
    sourceFamily: getSourceFamily(sourceId),
    source: canonicalizeDisplaySource(spec.source || inferDisplaySource(sourceId)),
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

function inferDisplaySource(sourceId) {
  if (typeof sourceId === "string" && sourceId.startsWith("codex")) {
    return "Codex";
  }

  if (typeof sourceId === "string" && sourceId.startsWith("claude")) {
    return "Claude";
  }

  return "";
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

  if (/^claude(?:-hook)?$/i.test(trimmed)) {
    return "Claude";
  }

  if (/^codex(?:[- ].+)?$/i.test(trimmed)) {
    return "Codex";
  }

  if (/^(unknown|notification)$/i.test(trimmed)) {
    return "";
  }

  return trimmed;
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
  if (typeof sourceId === "string" && sourceId.startsWith("codex")) {
    return "codex";
  }

  if (typeof sourceId === "string" && sourceId.startsWith("claude")) {
    return "claude";
  }

  return "generic";
}

function buildCandidateSummary(candidate) {
  const keys = isPlainObject(candidate.parsed) ? Object.keys(candidate.parsed).sort().join(",") : "";
  return `payload transport=${candidate.transport} parsed=${candidate.parseState} keys=${keys} rawLength=${candidate.raw.length}`;
}

function normalizePayloadString(value) {
  return typeof value === "string" ? value.replace(/^\uFEFF/, "").trim() : "";
}

function parseJsonMaybe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function looksLikeJson(value) {
  return value.startsWith("{") || value.startsWith("[");
}

function describeParsedValue(value) {
  if (Array.isArray(value)) {
    return "array";
  }

  if (value && typeof value === "object") {
    return "object";
  }

  return value === null ? "invalid" : typeof value;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasAnyKey(payload, keys) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(payload, key));
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
  createNotificationSpec,
  getIncomingPayloadCandidates,
  getSourceFamily,
  normalizeIncomingNotification,
  parseJsonMaybe,
};
