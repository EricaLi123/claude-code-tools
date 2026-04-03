const fs = require("fs");
const path = require("path");

const {
  findSidecarTerminalContextForProjectDir,
  findSidecarTerminalContextForSession,
} = require("./codex-sidecar-state");
const { emitNotification } = require("./notify-runtime");
const { fileExistsCaseInsensitive } = require("./shared-utils");

const CODEX_APPROVAL_NOTIFY_GRACE_MS = 1000;
const CODEX_READ_ONLY_APPROVAL_NOTIFY_GRACE_MS = 5 * 1000;
const CODEX_APPROVAL_BATCH_WINDOW_MS = 500;
const RECENT_REQUIRE_ESCALATED_TTL_MS = 30 * 60 * 1000;
const SESSION_APPROVAL_CONFIRM_LOOKBACK_MS = 5 * 60 * 1000;
const SESSION_APPROVAL_GRANT_TTL_MS = 30 * 60 * 1000;
const MAX_RECENT_REQUIRE_ESCALATED_EVENTS_PER_SESSION = 64;
const MAX_SESSION_APPROVAL_GRANTS_PER_SESSION = 128;
const COMMAND_APPROVAL_ROOT_MAX_DEPTH = 8;
const COMMAND_APPROVAL_ROOT_MARKERS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "Gemfile",
  "composer.json",
  ".git",
];

function emitCodexApprovalNotification({ event, runtime, terminal, emittedEventKeys, origin }) {
  if (!shouldEmitEventKey(emittedEventKeys, event.dedupeKey)) {
    return false;
  }

  runtime.log(
    `${origin} event matched type=${event.eventType} sessionId=${event.sessionId || "unknown"} turnId=${event.turnId || ""} cwd=${event.projectDir || ""}`
  );

  const notificationTerminal = resolveApprovalTerminalContext({
    sessionId: event.sessionId,
    projectDir: event.projectDir,
    fallbackTerminal: terminal,
    log: runtime.log,
  });

  const child = emitNotification({
    source: event.source,
    eventName: event.eventName,
    title: event.title,
    message: event.message,
    rawEventType: event.eventType,
    runtime,
    terminal: notificationTerminal,
  });

  child.on("close", (code) => {
    runtime.log(
      `notify.ps1 exited code=${code} sessionId=${event.sessionId || "unknown"} eventType=${event.eventType}`
    );
  });

  child.on("error", (error) => {
    runtime.log(
      `notify.ps1 spawn failed sessionId=${event.sessionId || "unknown"} eventType=${event.eventType} error=${error.message}`
    );
  });

  return true;
}

function queuePendingApprovalNotification({
  runtime,
  pendingApprovalNotifications,
  pendingApprovalCallIds,
  emittedEventKeys,
  event,
}) {
  const key = event.dedupeKey || `${event.sessionId || "unknown"}|${event.turnId || "unknown"}`;
  if (key && emittedEventKeys && emittedEventKeys.has(key)) {
    return;
  }
  const existing = pendingApprovalNotifications.get(key);

  if (existing) {
    if (!existing.callId && event.callId) {
      existing.callId = event.callId;
      pendingApprovalCallIds.set(event.callId, key);
    }
    return;
  }

  const graceMs = getCodexApprovalNotifyGraceMs(event);
  const pending = {
    ...event,
    pendingSinceMs: Date.now(),
    deadlineMs: Date.now() + graceMs,
    graceMs,
  };

  pendingApprovalNotifications.set(key, pending);
  if (pending.callId) {
    pendingApprovalCallIds.set(pending.callId, key);
  }

  runtime.log(
    `queued approval pending sessionId=${pending.sessionId || "unknown"} turnId=${pending.turnId || ""} callId=${pending.callId || ""} graceMs=${graceMs} deadlineMs=${pending.deadlineMs}`
  );
}

function cancelPendingApprovalNotification({
  runtime,
  pendingApprovalNotifications,
  pendingApprovalCallIds,
  callId,
  reason,
}) {
  if (!callId) {
    return false;
  }

  const key = pendingApprovalCallIds.get(callId);
  if (!key) {
    return false;
  }

  return cancelPendingApprovalNotificationByKey({
    runtime,
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    key,
    reason,
  });
}

function cancelPendingApprovalNotificationByKey({
  runtime,
  pendingApprovalNotifications,
  pendingApprovalCallIds,
  key,
  reason,
}) {
  if (!key) {
    return false;
  }

  const pending = pendingApprovalNotifications.get(key);
  if (!pending) {
    pendingApprovalCallIds.forEach((mappedKey, mappedCallId) => {
      if (mappedKey === key) {
        pendingApprovalCallIds.delete(mappedCallId);
      }
    });
    return false;
  }

  pendingApprovalNotifications.delete(key);
  if (pending.callId) {
    pendingApprovalCallIds.delete(pending.callId);
  }
  runtime.log(
    `cancelled approval pending sessionId=${pending.sessionId || "unknown"} turnId=${pending.turnId || ""} callId=${pending.callId || ""} reason=${reason || "unknown"}`
  );
  return true;
}

function cancelPendingApprovalNotificationsBySuppression({
  runtime,
  pendingApprovalNotifications,
  pendingApprovalCallIds,
  sessionId,
  turnId = "",
  approvalPolicy = "",
  sandboxPolicy = null,
  approvedCommandRules = [],
  sessionApprovalGrants,
  nowMs = Date.now(),
}) {
  if (!runtime || !pendingApprovalNotifications || !sessionId) {
    return 0;
  }

  let cancelled = 0;
  Array.from(pendingApprovalNotifications.entries()).forEach(([key, pending]) => {
    if (!pending || pending.sessionId !== sessionId) {
      return;
    }
    if (turnId && pending.turnId && pending.turnId !== turnId) {
      return;
    }

    const suppressionReason =
      getCodexRequireEscalatedSuppressionReason({
        event: pending,
        approvalPolicy,
        sandboxPolicy,
        approvedCommandRules,
      }) ||
      getSessionRequireEscalatedSuppressionReason({
        event: pending,
        nowMs,
        sessionApprovalGrants,
      });

    if (!suppressionReason) {
      return;
    }

    if (
      cancelPendingApprovalNotificationByKey({
        runtime,
        pendingApprovalNotifications,
        pendingApprovalCallIds,
        key,
        reason: suppressionReason,
      })
    ) {
      cancelled += 1;
    }
  });

  return cancelled;
}

function buildPendingApprovalBatchKey(event) {
  if (!event) {
    return "";
  }

  if (event.eventType === "require_escalated_tool_call") {
    return [event.sessionId || "unknown", event.turnId || "unknown", event.eventType].join("|");
  }

  return (
    event.dedupeKey ||
    [event.sessionId || "unknown", event.turnId || "unknown", event.eventType || ""].join("|")
  );
}

function shouldBatchPendingApproval(representative, pending) {
  if (!representative || !pending) {
    return false;
  }

  if (buildPendingApprovalBatchKey(representative) !== buildPendingApprovalBatchKey(pending)) {
    return false;
  }

  if (representative.eventType !== "require_escalated_tool_call") {
    return representative.dedupeKey === pending.dedupeKey;
  }

  const representativePendingSince = Number.isFinite(representative.pendingSinceMs)
    ? representative.pendingSinceMs
    : 0;
  const pendingSince = Number.isFinite(pending.pendingSinceMs)
    ? pending.pendingSinceMs
    : representativePendingSince;

  return Math.abs(pendingSince - representativePendingSince) <= CODEX_APPROVAL_BATCH_WINDOW_MS;
}

function drainPendingApprovalBatch({
  pendingApprovalNotifications,
  pendingApprovalCallIds,
  representativeKey,
}) {
  if (!pendingApprovalNotifications || !representativeKey) {
    return { batchKey: "", count: 0, representative: null };
  }

  const representative = pendingApprovalNotifications.get(representativeKey);
  if (!representative) {
    return { batchKey: "", count: 0, representative: null };
  }

  const batchKey = buildPendingApprovalBatchKey(representative);
  const removed = [];

  Array.from(pendingApprovalNotifications.entries()).forEach(([key, pending]) => {
    if (!shouldBatchPendingApproval(representative, pending)) {
      return;
    }

    pendingApprovalNotifications.delete(key);
    if (pending.callId) {
      pendingApprovalCallIds.delete(pending.callId);
    }
    removed.push({ key, pending });
  });

  return {
    batchKey,
    count: removed.length,
    representative,
  };
}

function flushPendingApprovalNotifications({
  runtime,
  terminal,
  emittedEventKeys,
  pendingApprovalNotifications,
  pendingApprovalCallIds,
}) {
  const now = Date.now();
  Array.from(pendingApprovalNotifications.entries()).forEach(([key, pending]) => {
    if (!pendingApprovalNotifications.has(key)) {
      return;
    }
    if (pending.deadlineMs > now) {
      return;
    }

    const batch = drainPendingApprovalBatch({
      pendingApprovalNotifications,
      pendingApprovalCallIds,
      representativeKey: key,
    });
    if (!batch.representative) {
      return;
    }

    if (batch.count > 1) {
      runtime.log(
        `grouped approval batch sessionId=${batch.representative.sessionId || "unknown"} turnId=${batch.representative.turnId || ""} batchSize=${batch.count}`
      );
    }

    emitCodexApprovalNotification({
      event: batch.representative,
      runtime,
      terminal,
      emittedEventKeys,
      origin: "pending",
    });
  });
}

function createApprovedCommandRuleCache(filePath) {
  return {
    filePath,
    mtimeMs: -1,
    size: -1,
    rules: [],
  };
}

function getApprovedCommandRules(cache, log) {
  if (!cache || !cache.filePath || !fileExistsCaseInsensitive(cache.filePath)) {
    return [];
  }

  let stat;
  try {
    stat = fs.statSync(cache.filePath);
  } catch (error) {
    log(`approved rules stat failed file=${cache.filePath} error=${error.message}`);
    return cache.rules || [];
  }

  if (cache.mtimeMs === stat.mtimeMs && cache.size === stat.size && Array.isArray(cache.rules)) {
    return cache.rules;
  }

  try {
    const content = fs.readFileSync(cache.filePath, "utf8");
    cache.rules = parseApprovedCommandRules(content);
    cache.mtimeMs = stat.mtimeMs;
    cache.size = stat.size;
  } catch (error) {
    log(`approved rules read failed file=${cache.filePath} error=${error.message}`);
  }

  return cache.rules || [];
}

function parseApprovedCommandRules(content) {
  const lines = String(content || "").split(/\r?\n/);
  const rules = [];

  lines.forEach((line) => {
    if (!line.includes('decision="allow"') || !line.includes("prefix_rule(")) {
      return;
    }

    const match = line.match(/prefix_rule\(pattern=(\[[\s\S]*\]), decision="allow"\)\s*$/);
    if (!match) {
      return;
    }

    let pattern;
    try {
      pattern = JSON.parse(match[1]);
    } catch {
      return;
    }

    if (!Array.isArray(pattern) || !pattern.every((value) => typeof value === "string")) {
      return;
    }

    const shellCommand = extractApprovedRuleShellCommand(pattern);
    rules.push({
      pattern,
      shellCommand,
      shellCommandTokens: shellCommand ? extractLeadingCommandTokens(shellCommand) : [],
    });
  });

  return rules;
}

function extractApprovedRuleShellCommand(pattern) {
  if (!Array.isArray(pattern) || pattern.length < 3) {
    return "";
  }

  const exeName = path.basename(pattern[0] || "").toLowerCase();
  const arg1 = String(pattern[1] || "").toLowerCase();
  if (
    (exeName === "powershell.exe" ||
      exeName === "powershell" ||
      exeName === "pwsh.exe" ||
      exeName === "pwsh") &&
    arg1 === "-command"
  ) {
    return String(pattern[2] || "").trim();
  }
  if ((exeName === "cmd.exe" || exeName === "cmd") && arg1 === "/c") {
    return String(pattern[2] || "").trim();
  }
  return "";
}

function getCodexApprovalNotifyGraceMs(event) {
  if (
    event &&
    event.eventType === "require_escalated_tool_call" &&
    isLikelyReadOnlyShellCommand(event.toolArgs)
  ) {
    return CODEX_READ_ONLY_APPROVAL_NOTIFY_GRACE_MS;
  }

  return CODEX_APPROVAL_NOTIFY_GRACE_MS;
}

function getCodexRequireEscalatedSuppressionReason({
  event,
  approvalPolicy,
  sandboxPolicy,
  approvedCommandRules,
}) {
  if (!event || event.eventType !== "require_escalated_tool_call" || !event.toolArgs) {
    return "";
  }

  if (approvalPolicy === "never") {
    return "approval_policy_never";
  }

  if (sandboxPolicy && sandboxPolicy.type === "danger-full-access") {
    return "danger_full_access";
  }

  if (
    isLikelyReadOnlyShellCommand(event.toolArgs) &&
    matchesApprovedCommandRule(event.toolArgs, approvedCommandRules)
  ) {
    return "approved_rule";
  }

  return "";
}

function pruneRecentRequireEscalatedEvents(
  recentRequireEscalatedEvents,
  sessionId,
  nowMs = Date.now()
) {
  if (!recentRequireEscalatedEvents || !sessionId) {
    return [];
  }

  const recent = recentRequireEscalatedEvents.get(sessionId);
  if (!Array.isArray(recent) || !recent.length) {
    recentRequireEscalatedEvents.delete(sessionId);
    return [];
  }

  const next = recent.filter(
    (item) =>
      item &&
      typeof item.seenAtMs === "number" &&
      item.seenAtMs + RECENT_REQUIRE_ESCALATED_TTL_MS >= nowMs
  );
  if (next.length) {
    recentRequireEscalatedEvents.set(sessionId, next);
  } else {
    recentRequireEscalatedEvents.delete(sessionId);
  }

  return next;
}

function rememberRecentRequireEscalatedEvent(
  recentRequireEscalatedEvents,
  event,
  nowMs = Date.now()
) {
  if (
    !recentRequireEscalatedEvents ||
    !event ||
    event.eventType !== "require_escalated_tool_call" ||
    !event.sessionId ||
    !event.toolArgs
  ) {
    return;
  }

  const sessionId = event.sessionId;
  const recent = pruneRecentRequireEscalatedEvents(
    recentRequireEscalatedEvents,
    sessionId,
    nowMs
  ).filter((item) => item.dedupeKey !== event.dedupeKey);

  recent.push({
    dedupeKey: event.dedupeKey || "",
    projectDir: event.projectDir || "",
    sessionId,
    seenAtMs: nowMs,
    toolArgs: event.toolArgs,
    turnId: event.turnId || "",
  });

  while (recent.length > MAX_RECENT_REQUIRE_ESCALATED_EVENTS_PER_SESSION) {
    recent.shift();
  }

  recentRequireEscalatedEvents.set(sessionId, recent);
}

function pruneSessionApprovalGrants(sessionApprovalGrants, sessionId, nowMs = Date.now()) {
  if (!sessionApprovalGrants || !sessionId) {
    return [];
  }

  const grants = sessionApprovalGrants.get(sessionId);
  if (!Array.isArray(grants) || !grants.length) {
    sessionApprovalGrants.delete(sessionId);
    return [];
  }

  const next = grants.filter(
    (item) =>
      item &&
      typeof item.confirmedAtMs === "number" &&
      item.confirmedAtMs + SESSION_APPROVAL_GRANT_TTL_MS >= nowMs
  );
  if (next.length) {
    sessionApprovalGrants.set(sessionId, next);
  } else {
    sessionApprovalGrants.delete(sessionId);
  }

  return next;
}

function rememberSessionApprovalRoots(
  sessionApprovalGrants,
  sessionId,
  roots,
  { confirmedAtMs = Date.now(), source = "", turnId = "" } = {}
) {
  if (!sessionApprovalGrants || !sessionId || !Array.isArray(roots) || !roots.length) {
    return 0;
  }

  const grants = pruneSessionApprovalGrants(sessionApprovalGrants, sessionId, confirmedAtMs);
  let added = 0;

  roots.forEach((root) => {
    const normalizedRoot = normalizeShellCommandPath(root);
    if (!normalizedRoot) {
      return;
    }

    const existing = grants.find((item) => item.root === normalizedRoot);
    if (existing) {
      existing.confirmedAtMs = confirmedAtMs;
      existing.source = source || existing.source || "";
      existing.turnId = turnId || existing.turnId || "";
      return;
    }

    grants.push({
      confirmedAtMs,
      root: normalizedRoot,
      source,
      turnId,
    });
    added += 1;
  });

  while (grants.length > MAX_SESSION_APPROVAL_GRANTS_PER_SESSION) {
    grants.shift();
  }

  if (grants.length) {
    sessionApprovalGrants.set(sessionId, grants);
  }

  return added;
}

function confirmSessionApprovalForRecentEvents({
  recentRequireEscalatedEvents,
  runtime,
  sessionApprovalGrants,
  sessionId,
  source,
  turnId,
  nowMs = Date.now(),
}) {
  if (!sessionId || !recentRequireEscalatedEvents || !sessionApprovalGrants) {
    return 0;
  }

  const recent = pruneRecentRequireEscalatedEvents(recentRequireEscalatedEvents, sessionId, nowMs);
  if (!recent.length) {
    return 0;
  }

  const roots = Array.from(
    new Set(
      recent
        .filter(
          (item) =>
            item &&
            item.seenAtMs + SESSION_APPROVAL_CONFIRM_LOOKBACK_MS >= nowMs &&
            (!turnId || !item.turnId || item.turnId === turnId)
        )
        .flatMap((item) => extractCommandApprovalRoots(item.toolArgs))
    )
  );

  const added = rememberSessionApprovalRoots(sessionApprovalGrants, sessionId, roots, {
    confirmedAtMs: nowMs,
    source,
    turnId,
  });

  if (added > 0 && runtime && typeof runtime.log === "function") {
    runtime.log(
      `confirmed session approval sessionId=${sessionId} turnId=${turnId || ""} source=${source || ""} roots=${roots.join(";")}`
    );
  }

  return added;
}

function getSessionRequireEscalatedSuppressionReason({
  event,
  nowMs = Date.now(),
  sessionApprovalGrants,
}) {
  if (
    !event ||
    event.eventType !== "require_escalated_tool_call" ||
    !event.sessionId ||
    !event.toolArgs ||
    !isLikelyReadOnlyShellCommand(event.toolArgs)
  ) {
    return "";
  }

  const grants = pruneSessionApprovalGrants(sessionApprovalGrants, event.sessionId, nowMs);
  if (!grants.length) {
    return "";
  }

  const roots = extractCommandApprovalRoots(event.toolArgs);
  if (!roots.length) {
    return "";
  }

  const matched = roots.some((root) => grants.some((grant) => isPathWithinRoot(root, grant.root)));
  return matched ? "session_recent_read_grant" : "";
}

function matchesApprovedCommandRule(args, approvedCommandRules) {
  if (!args || !Array.isArray(approvedCommandRules) || !approvedCommandRules.length) {
    return false;
  }

  const normalizedCommand = normalizeShellCommandForMatch(args.command);
  const normalizedPrefixRule = normalizePrefixRule(args.prefix_rule);

  return approvedCommandRules.some((rule) => {
    if (!rule || !rule.shellCommand) {
      return false;
    }

    const normalizedRuleCommand = normalizeShellCommandForMatch(rule.shellCommand);
    if (normalizedCommand && normalizedRuleCommand && normalizedCommand === normalizedRuleCommand) {
      return true;
    }

    if (
      normalizedPrefixRule.length &&
      arrayStartsWith(rule.shellCommandTokens || [], normalizedPrefixRule)
    ) {
      return true;
    }

    return false;
  });
}

function normalizeShellCommandForMatch(command) {
  return String(command || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizePrefixRule(prefixRule) {
  if (!Array.isArray(prefixRule)) {
    return [];
  }

  return prefixRule
    .filter((value) => typeof value === "string")
    .map((value) => stripMatchingQuotes(String(value).trim()).toLowerCase())
    .filter(Boolean);
}

function isLikelyReadOnlyShellCommand(args) {
  if (!args || typeof args.command !== "string") {
    return false;
  }

  const tokens = extractLeadingCommandTokens(args.command);
  if (!tokens.length) {
    return false;
  }

  const command = tokens[0];
  if (
    new Set([
      "cat",
      "dir",
      "findstr",
      "get-childitem",
      "get-content",
      "ls",
      "rg",
      "select-string",
      "type",
    ]).has(command)
  ) {
    return true;
  }

  if (command === "git") {
    return new Set(["branch", "diff", "log", "remote", "rev-parse", "show", "status"]).has(
      tokens[1] || ""
    );
  }

  if (command === "node") {
    return tokens[1] === "-c";
  }

  return false;
}

function extractCommandApprovalRoots(args) {
  if (!args || typeof args.command !== "string") {
    return [];
  }

  const workdir = normalizeShellCommandPath(args.workdir);
  const roots = new Set();
  const absolutePathPattern = /[A-Za-z]:[\\/][^"'`\r\n|;]+/g;

  const pushRoot = (value) => {
    const normalized = normalizeShellCommandPath(value);
    if (!normalized) {
      return;
    }

    let root = normalized;
    const fsPath = normalized.replace(/\//g, path.sep);
    if (path.extname(fsPath)) {
      root = normalizeShellCommandPath(findCommandApprovalRootPath(path.dirname(fsPath)));
    } else {
      root = normalizeShellCommandPath(findCommandApprovalRootPath(fsPath));
    }

    if (root) {
      roots.add(root);
    }
  };

  let match;
  while ((match = absolutePathPattern.exec(args.command)) !== null) {
    pushRoot(match[0]);
  }

  tokenizeShellCommand(args.command).forEach((token) => {
    const candidate = normalizePathCandidate(token);
    if (!candidate) {
      return;
    }

    if (isWindowsAbsolutePath(candidate)) {
      pushRoot(candidate);
      return;
    }

    if (!workdir || !looksLikeRelativePathCandidate(candidate)) {
      return;
    }

    pushRoot(path.resolve(workdir.replace(/\//g, path.sep), candidate));
  });

  return Array.from(roots);
}

function extractLeadingCommandTokens(command) {
  const tokens = tokenizeShellCommand(command);
  const operators = new Set(["|", ";", "&&", "||"]);
  const result = [];
  let seenCommand = false;

  for (const token of tokens) {
    if (!token) {
      continue;
    }

    if (!seenCommand) {
      if (operators.has(token)) {
        continue;
      }
      if (looksLikePowerShellAssignment(token)) {
        continue;
      }

      seenCommand = true;
      result.push(normalizeShellToken(token));
      continue;
    }

    if (operators.has(token)) {
      break;
    }

    result.push(normalizeShellToken(token));
  }

  return result;
}

function tokenizeShellCommand(command) {
  const text = String(command || "");
  const tokens = [];
  let current = "";
  let quote = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1] || "";

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push(char + next);
      current = "";
      index += 1;
      continue;
    }

    if (char === "|" || char === ";") {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push(char);
      current = "";
      continue;
    }

    if (/\s/.test(char)) {
      if (current.trim()) {
        tokens.push(current.trim());
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    tokens.push(current.trim());
  }

  return tokens;
}

function looksLikePowerShellAssignment(token) {
  return /^\$[A-Za-z_][A-Za-z0-9_:.]*=/.test(String(token || ""));
}

function normalizePathCandidate(value) {
  return stripMatchingQuotes(String(value || "").trim())
    .replace(/^[([{]+/, "")
    .replace(/[)\],;]+$/, "");
}

function isWindowsAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || ""));
}

function looksLikeRelativePathCandidate(value) {
  const text = String(value || "");
  if (
    !text ||
    /^[A-Za-z]:[\\/]/.test(text) ||
    /^[A-Za-z]+:\/\//.test(text) ||
    text.startsWith("$")
  ) {
    return false;
  }

  return text.startsWith(".") || /[\\/]/.test(text);
}

function normalizeShellCommandPath(value) {
  const candidate = normalizePathCandidate(value);
  if (!isWindowsAbsolutePath(candidate)) {
    return "";
  }

  let normalized = candidate.replace(/\\/g, "/");
  if (normalized.length > 3) {
    normalized = normalized.replace(/\/+$/, "");
  }
  return normalized.toLowerCase();
}

function isPathWithinRoot(candidatePath, rootPath) {
  const candidate = normalizeShellCommandPath(candidatePath);
  const root = normalizeShellCommandPath(rootPath);
  if (!candidate || !root) {
    return false;
  }

  return candidate === root || candidate.startsWith(`${root}/`);
}

function findCommandApprovalRootPath(value) {
  let currentPath = "";
  try {
    currentPath = path.resolve(String(value || ""));
  } catch {
    return String(value || "");
  }

  let bestGitRoot = "";
  let currentDir = currentPath;

  for (let depth = 0; depth <= COMMAND_APPROVAL_ROOT_MAX_DEPTH; depth += 1) {
    const marker = findCommandApprovalRootMarker(currentDir);
    if (marker && marker !== ".git") {
      return currentDir;
    }
    if (marker === ".git" && !bestGitRoot) {
      bestGitRoot = currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (!parentDir || parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return bestGitRoot || currentPath;
}

function findCommandApprovalRootMarker(dirPath) {
  if (!dirPath) {
    return "";
  }

  return (
    COMMAND_APPROVAL_ROOT_MARKERS.find((marker) => fs.existsSync(path.join(dirPath, marker))) || ""
  );
}

function normalizeShellToken(token) {
  return stripMatchingQuotes(String(token || "").trim()).toLowerCase();
}

function stripMatchingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function arrayStartsWith(values, prefix) {
  if (!Array.isArray(values) || !Array.isArray(prefix) || prefix.length === 0) {
    return false;
  }

  if (values.length < prefix.length) {
    return false;
  }

  for (let index = 0; index < prefix.length; index += 1) {
    if (values[index] !== prefix[index]) {
      return false;
    }
  }

  return true;
}

function shouldEmitEventKey(emittedEventKeys, eventKey) {
  if (!eventKey) {
    return true;
  }

  if (emittedEventKeys.has(eventKey)) {
    return false;
  }

  emittedEventKeys.set(eventKey, Date.now());
  return true;
}

function resolveApprovalTerminalContext({ sessionId, projectDir, fallbackTerminal, log }) {
  const terminal = findSidecarTerminalContextForSession(sessionId, log);
  if (!terminal || (!terminal.hwnd && !terminal.shellPid)) {
    const projectFallback = findSidecarTerminalContextForProjectDir(projectDir, log);
    if (!projectFallback || !projectFallback.hwnd) {
      if (typeof log === "function") {
        log(
          `approval terminal fallback used sessionId=${sessionId || "unknown"} projectDir=${projectDir || ""} reason=no_sidecar_match`
        );
      }
      return fallbackTerminal;
    }

    if (typeof log === "function") {
      log(
        `approval terminal project fallback used sessionId=${sessionId || "unknown"} projectDir=${projectDir || ""} hwnd=${projectFallback.hwnd || ""}`
      );
    }

    return {
      hwnd: projectFallback.hwnd,
      shellPid: null,
      isWindowsTerminal: false,
    };
  }

  if (typeof log === "function") {
    log(
      `sidecar terminal matched sessionId=${sessionId} shellPid=${terminal.shellPid || ""} hwnd=${terminal.hwnd || ""}`
    );
  }

  return {
    hwnd: terminal.hwnd,
    shellPid: terminal.shellPid,
    isWindowsTerminal: terminal.isWindowsTerminal,
  };
}

module.exports = {
  buildPendingApprovalBatchKey,
  cancelPendingApprovalNotification,
  cancelPendingApprovalNotificationsBySuppression,
  confirmSessionApprovalForRecentEvents,
  createApprovedCommandRuleCache,
  drainPendingApprovalBatch,
  emitCodexApprovalNotification,
  extractCommandApprovalRoots,
  flushPendingApprovalNotifications,
  getApprovedCommandRules,
  getCodexApprovalNotifyGraceMs,
  getCodexRequireEscalatedSuppressionReason,
  getSessionRequireEscalatedSuppressionReason,
  isLikelyReadOnlyShellCommand,
  matchesApprovedCommandRule,
  parseApprovedCommandRules,
  queuePendingApprovalNotification,
  rememberRecentRequireEscalatedEvent,
  resolveApprovalTerminalContext,
  shouldBatchPendingApproval,
};
