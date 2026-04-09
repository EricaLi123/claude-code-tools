"use strict";

const {
  applyExplicitDisplayOverrides,
  createNotificationSpec,
  getExplicitDisplayOverrides,
} = require("./notification-source-display");

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
  const sessionId = getStringField(payload, ["thread-id", "thread_id", "threadId"]) || "unknown";
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
  getIncomingPayloadCandidates,
  normalizeIncomingNotification,
  parseJsonMaybe,
};
