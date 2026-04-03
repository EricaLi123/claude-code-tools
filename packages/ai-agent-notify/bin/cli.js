#!/usr/bin/env node

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { StringDecoder } = require("string_decoder");
const {
  parseRolloutTimestampFromPath,
  pickSidecarSessionCandidate,
  resolveSidecarSessionCandidate: resolveSidecarSessionCandidateCore,
  startSidecarSessionResolver,
} = require("../lib/codex-sidecar-resolver");
const {
  findSidecarTerminalContextForProjectDir,
  findSidecarTerminalContextForSession,
  writeSidecarRecord,
} = require("../lib/codex-sidecar-state");
const {
  LOG_DIR,
  createNeutralTerminalContext,
  createRuntime,
  detectTerminalContext,
  emitNotification,
  findParentInfo,
} = require("../lib/notify-runtime");
const {
  createNotificationSpec,
  normalizeIncomingNotification,
} = require("../lib/notification-sources");

const PACKAGE_VERSION = readPackageVersion();
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

if (require.main === module) {
  runCli();
}

async function runCli() {
  try {
    ensureWindows();
    await main();
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
  }
}

function ensureWindows() {
  if (process.platform !== "win32") {
    throw new Error("ai-agent-notify currently only supports Windows.");
  }
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === "codex-session-watch" || argv[0] === "--codex-session-watch") {
    await runCodexSessionWatchMode(
      argv[0] === "--codex-session-watch" ? argv.slice(1) : argv.slice(1)
    );
    return;
  }

  if (argv[0] === "codex-mcp-sidecar" || argv[0] === "mcp-sidecar") {
    await runCodexMcpSidecarMode(argv.slice(1));
    return;
  }

  if (argv[0] === "--help" || argv[0] === "help") {
    printHelp();
    return;
  }

  await runDefaultNotifyMode(argv);
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  ai-agent-notify",
      "  ai-agent-notify codex-session-watch [--sessions-dir <path>] [--tui-log <path>] [--poll-ms <ms>]",
      "  ai-agent-notify codex-mcp-sidecar",
      "",
      "Modes:",
      "  default      Read notification JSON from stdin or argv and show a notification",
      "  codex-session-watch  Watch local Codex rollout files and TUI logs for approval events",
      "  codex-mcp-sidecar  Run a minimal MCP sidecar that records Codex terminal/session hints and ensures codex-session-watch is running",
      "",
      "Flags:",
      "  --shell-pid <pid>  Override the detected shell pid",
      "  --sessions-dir <path>  Override the Codex sessions directory (default: %USERPROFILE%\\.codex\\sessions)",
      "  --tui-log <path>   Override the Codex TUI log path (default: %USERPROFILE%\\.codex\\log\\codex-tui.log)",
      "  --poll-ms <ms>     Poll interval for session file scanning (default: 1000)",
      "",
    ].join(os.EOL)
  );
}

async function runDefaultNotifyMode(argv) {
  const stdinData = readStdin();
  const notification = normalizeIncomingNotification({
    argv,
    stdinData,
    env: process.env,
  });
  const sessionId = notification.sessionId || "unknown";
  const runtime = createRuntime(sessionId);
  const terminal = detectTerminalContext(argv, runtime.log);

  runtime.log(
    `started mode=notify source=${notification.sourceId} transport=${notification.transport || "none"} session=${sessionId}`
  );
  runtime.log(notification.debugSummary);

  const child = emitNotification({
    source: notification.source,
    eventName: notification.eventName,
    title: notification.title,
    message: notification.message,
    rawEventType: notification.rawEventType,
    runtime,
    terminal,
  });

  child.on("close", (code) => {
    runtime.log(`notify.ps1 exited code=${code}`);
    process.exit(code || 0);
  });

  child.on("error", (error) => {
    runtime.log(`spawn failed: ${error.message}`);
    process.exit(0);
  });
}

async function runCodexSessionWatchMode(argv) {
  if (argv[0] === "--help" || argv[0] === "help") {
    printHelp();
    return;
  }

  const sessionsDir =
    getArgValue(argv, "--sessions-dir") ||
    getEnvFirst(["TOAST_NOTIFY_CODEX_SESSIONS_DIR"]) ||
    path.join(getCodexHomeDir(), "sessions");
  const tuiLogPath =
    getArgValue(argv, "--tui-log") ||
    getEnvFirst(["TOAST_NOTIFY_CODEX_TUI_LOG"]) ||
    path.join(getCodexHomeDir(), "log", "codex-tui.log");
  const pollMs = parsePositiveInteger(getArgValue(argv, "--poll-ms"), 1000);

  const runtime = createRuntime(`codex-session-watch-${Date.now()}`);
  const instanceLock = acquireSingleInstanceLock("codex-session-watch", runtime.log);
  if (!instanceLock.acquired) {
    runtime.log(
      `another codex-session-watch is already running pid=${instanceLock.existingPid || "unknown"}`
    );
    return;
  }

  const terminal = createNeutralTerminalContext();
  const fileStates = new Map();
  const sessionProjectDirs = new Map();
  const sessionApprovalContexts = new Map();
  const sessionApprovalGrants = new Map();
  const recentRequireEscalatedEvents = new Map();
  const emittedEventKeys = new Map();
  const pendingApprovalNotifications = new Map();
  const pendingApprovalCallIds = new Map();
  const approvedCommandRuleCache = createApprovedCommandRuleCache(
    path.join(getCodexHomeDir(), "rules", "default.rules")
  );
  let tuiLogState = null;
  let initialScan = true;
  let scanInProgress = false;
  let shuttingDown = false;

  runtime.log(
    `started mode=codex-session-watch sessionsDir=${sessionsDir} tuiLogPath=${tuiLogPath} pollMs=${pollMs}`
  );
  runtime.log(`acquired single-instance lock file=${instanceLock.lockPath}`);

  if (!fileExistsCaseInsensitive(sessionsDir)) {
    runtime.log(`sessions dir not found yet: ${sessionsDir}`);
  }

  if (!fileExistsCaseInsensitive(tuiLogPath)) {
    runtime.log(`tui log not found yet: ${tuiLogPath}`);
  }

  const interval = setInterval(scanOnce, pollMs);

  process.on("exit", () => releaseSingleInstanceLock(instanceLock, runtime.log));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  scanOnce();
  initialScan = false;

  function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(interval);
    runtime.log(`stopped mode=codex-session-watch signal=${signal}`);
    releaseSingleInstanceLock(instanceLock, runtime.log);
    process.exit(0);
  }

  function scanOnce() {
    if (scanInProgress) {
      return;
    }

    scanInProgress = true;
    try {
      const files = listRolloutFiles(sessionsDir, runtime.log);
      const existing = new Set(files);

      files.forEach((filePath) => {
        let stat;
        try {
          stat = fs.statSync(filePath);
        } catch (error) {
          runtime.log(`stat failed file=${filePath} error=${error.message}`);
          return;
        }

        let state = fileStates.get(filePath);
        if (!state) {
          state = createSessionFileState(filePath);
          fileStates.set(filePath, state);

          if (initialScan) {
            bootstrapExistingSessionFileState(state, stat, runtime.log);
          }

          runtime.log(
            `tracking session file=${filePath} position=${state.position} sessionId=${state.sessionId || "unknown"} cwd=${state.cwd || ""}`
          );
        }

        consumeSessionFileUpdates(state, stat, {
          runtime,
          terminal,
          emittedEventKeys,
          pendingApprovalNotifications,
          pendingApprovalCallIds,
          recentRequireEscalatedEvents,
          sessionApprovalGrants,
          approvedCommandRuleCache,
        });

        if (state.sessionId && state.cwd) {
          sessionProjectDirs.set(state.sessionId, state.cwd);
        }

        if (state.sessionId && (state.approvalPolicy || state.sandboxPolicy)) {
          sessionApprovalContexts.set(state.sessionId, {
            approvalPolicy: state.approvalPolicy || "",
            sandboxPolicy: state.sandboxPolicy || null,
          });
        }
      });

      Array.from(fileStates.keys()).forEach((filePath) => {
        if (!existing.has(filePath)) {
          fileStates.delete(filePath);
        }
      });

      tuiLogState = syncCodexTuiLogState(tuiLogState, tuiLogPath, {
        initialScan,
        runtime,
        terminal,
        emittedEventKeys,
        sessionProjectDirs,
        sessionApprovalContexts,
        pendingApprovalNotifications,
        pendingApprovalCallIds,
        recentRequireEscalatedEvents,
        sessionApprovalGrants,
        approvedCommandRuleCache,
      });

      flushPendingApprovalNotifications({
        runtime,
        terminal,
        emittedEventKeys,
        pendingApprovalNotifications,
        pendingApprovalCallIds,
      });
      pruneEmittedEventKeys(emittedEventKeys, 4096);
    } catch (error) {
      runtime.log(`session scan failed: ${error.message}`);
    } finally {
      scanInProgress = false;
    }
  }
}

async function runCodexMcpSidecarMode(argv) {
  if (argv[0] === "--help" || argv[0] === "help") {
    printHelp();
    return;
  }

  const runtime = createRuntime(`codex-mcp-sidecar-${Date.now()}`);
  ensureCodexSessionWatchRunning(runtime.log);
  const parentInfo = findParentInfo(runtime.log);
  const sessionsDir = path.join(getCodexHomeDir(), "sessions");
  const recordId = `codex-mcp-sidecar-${process.pid}-${Date.now()}`;
  let sidecarRecord = writeSidecarRecord({
    recordId,
    pid: process.pid,
    parentPid: process.ppid,
    cwd: process.cwd(),
    sessionId: "",
    startedAt: new Date().toISOString(),
    resolvedAt: "",
    hwnd: parentInfo.hwnd,
    shellPid: parentInfo.shellPid,
    isWindowsTerminal: parentInfo.isWindowsTerminal,
  });

  runtime.log(
    `started mode=codex-mcp-sidecar cwd=${sidecarRecord.cwd} shellPid=${sidecarRecord.shellPid || ""} hwnd=${sidecarRecord.hwnd || ""} sessionsDir=${sessionsDir}`
  );

  const resolver = startSidecarSessionResolver({
    getCurrentRecord: () => sidecarRecord,
    updateRecord(nextRecord) {
      sidecarRecord = writeSidecarRecord(nextRecord);
      return sidecarRecord;
    },
    sessionsDir,
    log: runtime.log,
    findCandidate: resolveSidecarSessionCandidate,
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    resolver.stop();
    runtime.log(
      `stopped mode=codex-mcp-sidecar recordId=${recordId} sessionId=${sidecarRecord.sessionId || ""} retained=1`
    );
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  try {
    await Promise.all([serveMinimalMcpServer({ runtime }), resolver.done]);
  } finally {
    cleanup();
  }
}

function serveMinimalMcpServer({ runtime }) {
  const reader = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  return new Promise((resolve) => {
    reader.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      let message;
      try {
        message = JSON.parse(stripUtf8Bom(line));
      } catch (error) {
        runtime.log(`mcp parse failed error=${error.message}`);
        return;
      }

      handleMcpServerMessage(message, runtime.log);
    });

    reader.on("close", resolve);
    process.stdin.on("end", resolve);
  });
}

function handleMcpServerMessage(message, log) {
  if (!message || typeof message.method !== "string") {
    return;
  }

  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  if (typeof log === "function") {
    log(`mcp method received method=${message.method} hasId=${hasId ? "1" : "0"}`);
  }
  if (!hasId) {
    return;
  }

  switch (message.method) {
    case "initialize":
      writeMcpResult(message.id, {
        protocolVersion:
          message &&
          message.params &&
          typeof message.params.protocolVersion === "string" &&
          message.params.protocolVersion
            ? message.params.protocolVersion
            : "2025-03-26",
        capabilities: {
          prompts: {},
          resources: {},
          tools: {},
        },
        serverInfo: {
          name: "ai-agent-notify",
          version: PACKAGE_VERSION,
        },
      });
      return;
    case "ping":
      writeMcpResult(message.id, {});
      return;
    case "tools/list":
      writeMcpResult(message.id, { tools: [] });
      return;
    case "resources/list":
      writeMcpResult(message.id, { resources: [] });
      return;
    case "resources/templates/list":
      writeMcpResult(message.id, { resourceTemplates: [] });
      return;
    case "prompts/list":
      writeMcpResult(message.id, { prompts: [] });
      return;
    default:
      log(`mcp unsupported method=${message.method}`);
      writeMcpError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

function writeMcpResult(id, result) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      result,
    })}\n`
  );
}

function writeMcpError(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
      },
    })}\n`
  );
}

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
    );
    return packageJson.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, { encoding: "utf8" });
}

function getArgValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : "";
}

function getEnvFirst(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function parsePositiveInteger(rawValue, fallbackValue) {
  const parsed = parseInt(rawValue, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function ensureCodexSessionWatchRunning(log) {
  const state = querySingleInstanceLock("codex-session-watch");
  if (state.running) {
    if (typeof log === "function") {
      log(`codex-session-watch already running pid=${state.pid} lock=${state.lockPath}`);
    }
    return { launched: false, pid: state.pid, lockPath: state.lockPath };
  }

  if (state.pid && typeof log === "function") {
    log(`codex-session-watch lock is stale pid=${state.pid} lock=${state.lockPath}`);
  }

  const child = launchCodexSessionWatchHidden([], log);
  return {
    launched: true,
    pid: child && child.pid ? child.pid : null,
    lockPath: state.lockPath,
  };
}

function launchCodexSessionWatchHidden(watcherArgs, log) {
  const launchArgs = buildCodexSessionWatchLaunchArgs(watcherArgs);
  const wscriptPath = getWindowsScriptHostPath();
  const launcherScript = getHiddenLauncherScriptPath();

  if (fileExistsCaseInsensitive(wscriptPath) && fileExistsCaseInsensitive(launcherScript)) {
    const child = spawnDetachedHiddenProcess(
      wscriptPath,
      [launcherScript, ...launchArgs],
      "codex-session-watch launcher",
      log
    );
    if (typeof log === "function") {
      log(`spawned codex-session-watch launcher pid=${child.pid || ""}`);
    }
    return child;
  }

  const child = spawnDetachedHiddenProcess(
    process.execPath,
    [path.resolve(__filename), "codex-session-watch", ...watcherArgs],
    "codex-session-watch direct",
    log
  );
  if (typeof log === "function") {
    log(`spawned codex-session-watch directly pid=${child.pid || ""}`);
  }
  return child;
}

function spawnDetachedHiddenProcess(command, args, label, log) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", (error) => {
    if (typeof log === "function") {
      log(`${label} spawn failed: ${error.message}`);
    }
  });
  child.unref();
  return child;
}

function buildCodexSessionWatchLaunchArgs(watcherArgs) {
  const extraArgs = Array.isArray(watcherArgs) ? watcherArgs : [];
  return [process.execPath, path.resolve(__filename), "codex-session-watch", ...extraArgs];
}

function getWindowsScriptHostPath() {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
}

function getHiddenLauncherScriptPath() {
  return path.join(__dirname, "..", "scripts", "start-hidden.vbs");
}

function acquireSingleInstanceLock(lockName, log) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const lockPath = getSingleInstanceLockPath(lockName);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(lockPath, "wx");
      fs.writeFileSync(
        handle,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
        "utf8"
      );
      fs.closeSync(handle);
      return { acquired: true, lockPath };
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        throw error;
      }

      const existingPid = readLockPid(lockPath);
      if (isProcessRunning(existingPid)) {
        return { acquired: false, lockPath, existingPid };
      }

      try {
        fs.unlinkSync(lockPath);
        if (typeof log === "function") {
          log(`removed stale lock file=${lockPath} pid=${existingPid || "unknown"}`);
        }
      } catch {
        return { acquired: false, lockPath, existingPid };
      }
    }
  }

  return { acquired: false, lockPath };
}

function querySingleInstanceLock(lockName) {
  const lockPath = getSingleInstanceLockPath(lockName);
  const pid = readLockPid(lockPath);

  return {
    lockPath,
    pid,
    running: isProcessRunning(pid),
  };
}

function getSingleInstanceLockPath(lockName) {
  return path.join(LOG_DIR, `${lockName}.lock`);
}

function releaseSingleInstanceLock(lockInfo, log) {
  if (!lockInfo || !lockInfo.lockPath || lockInfo.released) {
    return;
  }

  const ownerPid = readLockPid(lockInfo.lockPath);
  if (ownerPid && ownerPid !== process.pid) {
    lockInfo.released = true;
    return;
  }

  try {
    if (fs.existsSync(lockInfo.lockPath)) {
      fs.unlinkSync(lockInfo.lockPath);
      if (typeof log === "function") {
        log(`released single-instance lock file=${lockInfo.lockPath}`);
      }
    }
  } catch {}

  lockInfo.released = true;
}

function readLockPid(lockPath) {
  try {
    const payload = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const pid = parseInt(payload && payload.pid, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getCodexHomeDir() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function stripUtf8Bom(value) {
  return typeof value === "string" ? value.replace(/^\uFEFF/, "") : value;
}

function fileExistsCaseInsensitive(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function listRolloutFiles(rootDir, log) {
  if (!rootDir || !fileExistsCaseInsensitive(rootDir)) {
    return [];
  }

  const files = [];
  const pendingDirs = [rootDir];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    let entries = [];

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      log(`readdir failed dir=${currentDir} error=${error.message}`);
      continue;
    }

    entries.forEach((entry) => {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        pendingDirs.push(fullPath);
        return;
      }

      if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
        files.push(fullPath);
      }
    });
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function createSessionFileState(filePath) {
  return {
    filePath,
    position: 0,
    partial: "",
    decoder: new StringDecoder("utf8"),
    sessionId: parseSessionIdFromRolloutPath(filePath),
    cwd: "",
    turnId: "",
    approvalPolicy: "",
    sandboxPolicy: null,
  };
}

function createTailFileState(filePath) {
  return {
    filePath,
    position: 0,
    partial: "",
    decoder: new StringDecoder("utf8"),
    applyPatchCapture: null,
  };
}

function bootstrapExistingSessionFileState(state, stat, log) {
  const metadata = readRolloutMetadata(state.filePath, log);

  if (metadata.sessionId) {
    state.sessionId = metadata.sessionId;
  }

  if (metadata.cwd) {
    state.cwd = metadata.cwd;
  }

  if (metadata.approvalPolicy) {
    state.approvalPolicy = metadata.approvalPolicy;
  }

  if (metadata.sandboxPolicy) {
    state.sandboxPolicy = metadata.sandboxPolicy;
  }

  state.position = stat.size;
  state.partial = "";
  state.decoder = new StringDecoder("utf8");
}

function bootstrapTailFileState(state, stat) {
  state.position = stat.size;
  state.partial = "";
  state.decoder = new StringDecoder("utf8");
}

function parseSessionIdFromRolloutPath(filePath) {
  const match = path
    .basename(filePath)
    .match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/i);
  return match ? match[1] : "";
}

function readRolloutMetadata(filePath, log) {
  const result = {
    sessionId: parseSessionIdFromRolloutPath(filePath),
    cwd: "",
    approvalPolicy: "",
    sandboxPolicy: null,
    latestEventAtMs: 0,
  };

  try {
    const stat = fs.statSync(filePath);
    if (!stat.size) {
      return result;
    }

    const headBytesToRead = Math.min(stat.size, 65536);
    const headBuffer = readFileRange(filePath, 0, headBytesToRead);
    consumeRolloutMetadataChunk(result, headBuffer, false);

    if (stat.size > headBytesToRead) {
      const tailBytesToRead = Math.min(stat.size, 262144);
      const tailBuffer = readFileRange(filePath, stat.size - tailBytesToRead, tailBytesToRead);
      consumeRolloutMetadataChunk(result, tailBuffer, true);
    }
  } catch (error) {
    log(`metadata read failed file=${filePath} error=${error.message}`);
  }

  return result;
}

function resolveSidecarSessionCandidate(args) {
  return resolveSidecarSessionCandidateCore({
    ...args,
    fileExistsCaseInsensitive,
    listRolloutFiles,
    readRolloutMetadata,
  });
}

function consumeRolloutMetadataChunk(result, buffer, preferLatestTurnContext) {
  const lines = buffer.toString("utf8").split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(stripUtf8Bom(line));
    } catch {
      continue;
    }

    const recordTimestampMs = Date.parse(record.timestamp || "");
    if (Number.isFinite(recordTimestampMs) && recordTimestampMs > result.latestEventAtMs) {
      result.latestEventAtMs = recordTimestampMs;
    }

    if (record.type === "session_meta" && record.payload) {
      if (record.payload.id) {
        result.sessionId = record.payload.id;
      }
      if (!result.cwd && record.payload.cwd) {
        result.cwd = record.payload.cwd;
      }
      continue;
    }

    if (record.type !== "turn_context" || !record.payload) {
      continue;
    }

    if (record.payload.cwd && (preferLatestTurnContext || !result.cwd)) {
      result.cwd = record.payload.cwd;
    }

    if (record.payload.approval_policy && (preferLatestTurnContext || !result.approvalPolicy)) {
      result.approvalPolicy = record.payload.approval_policy;
    }

    if (record.payload.sandbox_policy && (preferLatestTurnContext || !result.sandboxPolicy)) {
      result.sandboxPolicy = record.payload.sandbox_policy;
    }
  }
}

function readFileRange(filePath, start, length) {
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");

  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }

  return buffer;
}

function consumeSessionFileUpdates(
  state,
  stat,
  {
    runtime,
    terminal,
    emittedEventKeys,
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    recentRequireEscalatedEvents,
    sessionApprovalGrants,
    approvedCommandRuleCache,
  }
) {
  if (stat.size < state.position) {
    runtime.log(`session file truncated file=${state.filePath}`);
    state.position = 0;
    state.partial = "";
    state.decoder = new StringDecoder("utf8");
  }

  if (stat.size === state.position) {
    return;
  }

  const chunk = readFileRange(state.filePath, state.position, stat.size - state.position);
  state.position = stat.size;

  const text = state.partial + state.decoder.write(chunk);
  const lines = text.split(/\r?\n/);
  state.partial = lines.pop() || "";

  lines.forEach((line) => {
    if (!line.trim()) {
      return;
    }

    handleSessionRecord(state, line, {
      runtime,
      terminal,
      emittedEventKeys,
      pendingApprovalNotifications,
      pendingApprovalCallIds,
      recentRequireEscalatedEvents,
      sessionApprovalGrants,
      approvedCommandRuleCache,
    });
  });
}

function syncCodexTuiLogState(state, tuiLogPath, context) {
  if (!tuiLogPath || !fileExistsCaseInsensitive(tuiLogPath)) {
    return state;
  }

  let stat;
  try {
    stat = fs.statSync(tuiLogPath);
  } catch (error) {
    context.runtime.log(`tui log stat failed file=${tuiLogPath} error=${error.message}`);
    return state;
  }

  let nextState = state;
  if (!nextState || nextState.filePath !== tuiLogPath) {
    nextState = createTailFileState(tuiLogPath);
    if (context.initialScan) {
      bootstrapTailFileState(nextState, stat);
    }
    context.runtime.log(`tracking tui log file=${tuiLogPath} position=${nextState.position}`);
  }

  consumeCodexTuiLogUpdates(nextState, stat, context);
  return nextState;
}

function consumeCodexTuiLogUpdates(
  state,
  stat,
  {
    runtime,
    terminal,
    emittedEventKeys,
    sessionProjectDirs,
    sessionApprovalContexts,
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    recentRequireEscalatedEvents,
    sessionApprovalGrants,
    approvedCommandRuleCache,
  }
) {
  if (stat.size < state.position) {
    runtime.log(`tui log truncated file=${state.filePath}`);
    state.position = 0;
    state.partial = "";
    state.decoder = new StringDecoder("utf8");
  }

  if (stat.size === state.position) {
    return;
  }

  const chunk = readFileRange(state.filePath, state.position, stat.size - state.position);
  state.position = stat.size;

  const text = state.partial + state.decoder.write(chunk);
  const lines = text.split(/\r?\n/);
  state.partial = lines.pop() || "";

  lines.forEach((line) => {
    handleCodexTuiLogLine(state, line, {
      runtime,
      terminal,
      emittedEventKeys,
      sessionProjectDirs,
      sessionApprovalContexts,
      pendingApprovalNotifications,
      pendingApprovalCallIds,
      recentRequireEscalatedEvents,
      sessionApprovalGrants,
      approvedCommandRuleCache,
    });
  });
}

function parseJsonObjectMaybe(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return typeof value === "object" && !Array.isArray(value) ? value : null;
}

function getCodexExecApprovalDescriptor(toolName, args) {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (command) {
    return `${toolName || "tool"}:${command}`;
  }

  return toolName || "tool";
}

function normalizeInlineText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function sanitizeDedupeDescriptorPart(value) {
  return normalizeInlineText(value).replace(/[|]/g, "/").slice(0, 80);
}

function getCodexInputRequestQuestions(args) {
  return Array.isArray(args && args.questions)
    ? args.questions.filter((question) => question && typeof question === "object" && !Array.isArray(question))
    : [];
}

function getCodexInputRequestDescriptor(args) {
  const questions = getCodexInputRequestQuestions(args);
  if (!questions.length) {
    return "request_user_input";
  }

  const parts = questions.slice(0, 3).map((question, index) => {
    return (
      sanitizeDedupeDescriptorPart(question.id) ||
      sanitizeDedupeDescriptorPart(question.header) ||
      sanitizeDedupeDescriptorPart(question.question) ||
      `q${index + 1}`
    );
  });

  return `request_user_input:${parts.join(",")}:${questions.length}`;
}

function getCodexInputRequestMessage(args) {
  const questions = getCodexInputRequestQuestions(args);
  if (!questions.length) {
    return "Waiting for your input";
  }

  const firstQuestion =
    normalizeInlineText(questions[0].question) || normalizeInlineText(questions[0].header);

  if (!firstQuestion) {
    return "Waiting for your input";
  }

  return questions.length > 1 ? `${firstQuestion} (+${questions.length - 1} more)` : firstQuestion;
}

function buildApprovalDedupeKey({
  sessionId,
  turnId,
  callId,
  approvalId,
  fallbackId,
  approvalKind,
  descriptor,
}) {
  return [
    sessionId || "unknown",
    approvalKind || "permission",
    turnId || approvalId || callId || fallbackId || "unknown",
    descriptor || "",
  ].join("|");
}

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

  return event.dedupeKey || [event.sessionId || "unknown", event.turnId || "unknown", event.eventType || ""].join("|");
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
  if ((exeName === "powershell.exe" || exeName === "powershell" || exeName === "pwsh.exe" || exeName === "pwsh") && arg1 === "-command") {
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

function pruneRecentRequireEscalatedEvents(recentRequireEscalatedEvents, sessionId, nowMs = Date.now()) {
  if (!recentRequireEscalatedEvents || !sessionId) {
    return [];
  }

  const recent = recentRequireEscalatedEvents.get(sessionId);
  if (!Array.isArray(recent) || !recent.length) {
    recentRequireEscalatedEvents.delete(sessionId);
    return [];
  }

  const next = recent.filter(
    (item) => item && typeof item.seenAtMs === "number" && item.seenAtMs + RECENT_REQUIRE_ESCALATED_TTL_MS >= nowMs
  );
  if (next.length) {
    recentRequireEscalatedEvents.set(sessionId, next);
  } else {
    recentRequireEscalatedEvents.delete(sessionId);
  }

  return next;
}

function rememberRecentRequireEscalatedEvent(recentRequireEscalatedEvents, event, nowMs = Date.now()) {
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
  const recent = pruneRecentRequireEscalatedEvents(recentRequireEscalatedEvents, sessionId, nowMs).filter(
    (item) => item.dedupeKey !== event.dedupeKey
  );

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
    (item) => item && typeof item.confirmedAtMs === "number" && item.confirmedAtMs + SESSION_APPROVAL_GRANT_TTL_MS >= nowMs
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

    if (normalizedPrefixRule.length && arrayStartsWith(rule.shellCommandTokens || [], normalizedPrefixRule)) {
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
    return new Set(["branch", "diff", "log", "remote", "rev-parse", "show", "status"]).has(tokens[1] || "");
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
  if (!text || /^[A-Za-z]:[\\/]/.test(text) || /^[A-Za-z]+:\/\//.test(text) || text.startsWith("$")) {
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

  return COMMAND_APPROVAL_ROOT_MARKERS.find((marker) =>
    fs.existsSync(path.join(dirPath, marker))
  ) || "";
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


function handleSessionRecord(
  state,
  line,
  {
    runtime,
    terminal,
    emittedEventKeys,
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    recentRequireEscalatedEvents,
    sessionApprovalGrants,
    approvedCommandRuleCache,
  }
) {
  let record;
  try {
    record = JSON.parse(stripUtf8Bom(line));
  } catch (error) {
    runtime.log(`failed to parse session line file=${state.filePath} error=${error.message}`);
    return;
  }

  if (record.type === "session_meta" && record.payload) {
    if (record.payload.id) {
      state.sessionId = record.payload.id;
    }
    if (record.payload.cwd) {
      state.cwd = record.payload.cwd;
    }
    return;
  }

  if (record.type === "turn_context" && record.payload) {
    if (record.payload.cwd) {
      state.cwd = record.payload.cwd;
    }
    if (record.payload.turn_id) {
      state.turnId = record.payload.turn_id;
    }
    if (record.payload.approval_policy) {
      state.approvalPolicy = record.payload.approval_policy;
    }
    if (record.payload.sandbox_policy) {
      state.sandboxPolicy = record.payload.sandbox_policy;
    }
    return;
  }

  if (
    record.type === "response_item" &&
    record.payload &&
    record.payload.type === "function_call_output" &&
    record.payload.call_id
  ) {
    cancelPendingApprovalNotification({
      runtime,
      pendingApprovalNotifications,
      pendingApprovalCallIds,
      callId: record.payload.call_id,
      reason: "function_call_output",
    });
    return;
  }

  if (isApprovedCommandRuleSavedRecord(record)) {
    confirmSessionApprovalForRecentEvents({
      recentRequireEscalatedEvents,
      runtime,
      sessionApprovalGrants,
      sessionId: state.sessionId || parseSessionIdFromRolloutPath(state.filePath) || "",
      source: "approved_rule_saved",
      turnId: state.turnId || "",
    });
    cancelPendingApprovalNotificationsBySuppression({
      runtime,
      pendingApprovalNotifications,
      pendingApprovalCallIds,
      sessionId: state.sessionId || parseSessionIdFromRolloutPath(state.filePath) || "",
      turnId: state.turnId || "",
      approvalPolicy: state.approvalPolicy || "",
      sandboxPolicy: state.sandboxPolicy || null,
      approvedCommandRules: getApprovedCommandRules(approvedCommandRuleCache, runtime.log),
      sessionApprovalGrants,
    });
    return;
  }

  if (
    (record.type !== "event_msg" && record.type !== "response_item") ||
    !record.payload ||
    typeof record.payload.type !== "string"
  ) {
    return;
  }

  const event = buildCodexSessionEvent(state, record);
  if (!event) {
    return;
  }

  if (event.eventType === "require_escalated_tool_call") {
    const suppressionReason = getCodexRequireEscalatedSuppressionReason({
      event,
      approvalPolicy: state.approvalPolicy,
      sandboxPolicy: state.sandboxPolicy,
      approvedCommandRules: getApprovedCommandRules(approvedCommandRuleCache, runtime.log),
    });

    if (suppressionReason) {
      runtime.log(
        `suppressed session require_escalated sessionId=${event.sessionId || "unknown"} turnId=${event.turnId || ""} reason=${suppressionReason}`
      );
      return;
    }

    const sessionSuppressionReason = getSessionRequireEscalatedSuppressionReason({
      event,
      sessionApprovalGrants,
    });
    if (sessionSuppressionReason) {
      runtime.log(
        `suppressed session require_escalated sessionId=${event.sessionId || "unknown"} turnId=${event.turnId || ""} reason=${sessionSuppressionReason}`
      );
      return;
    }

    rememberRecentRequireEscalatedEvent(recentRequireEscalatedEvents, event);

    if (event.approvalDispatch === "immediate") {
      emitCodexApprovalNotification({
        event,
        runtime,
        terminal,
        emittedEventKeys,
        origin: "session",
      });
      return;
    }

    queuePendingApprovalNotification({
      runtime,
      pendingApprovalNotifications,
      pendingApprovalCallIds,
      emittedEventKeys,
      event,
    });
    return;
  }

  emitCodexApprovalNotification({
    event,
    runtime,
    terminal,
    emittedEventKeys,
    origin: "session",
  });
}

function handleCodexTuiLogLine(
  tuiState,
  line,
  {
    runtime,
    terminal,
    emittedEventKeys,
    sessionProjectDirs,
    sessionApprovalContexts,
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    recentRequireEscalatedEvents,
    sessionApprovalGrants,
    approvedCommandRuleCache,
  }
) {
  if (!line || !line.trim()) {
    return;
  }

  const confirmation = parseCodexTuiApprovalConfirmation(line);
  if (confirmation) {
    const approvalContext = sessionApprovalContexts.get(confirmation.sessionId || "");
    confirmSessionApprovalForRecentEvents({
      recentRequireEscalatedEvents,
      runtime,
      sessionApprovalGrants,
      sessionId: confirmation.sessionId,
      source: confirmation.source,
    });
    cancelPendingApprovalNotificationsBySuppression({
      runtime,
      pendingApprovalNotifications,
      pendingApprovalCallIds,
      sessionId: confirmation.sessionId,
      approvalPolicy: (approvalContext && approvalContext.approvalPolicy) || "",
      sandboxPolicy: (approvalContext && approvalContext.sandboxPolicy) || null,
      sessionApprovalGrants,
    });
    return;
  }

  const event =
    buildCodexTuiApprovalEvent(tuiState, line, {
      sessionProjectDirs,
      sessionApprovalContexts,
    }) ||
    buildCodexTuiInputEvent(tuiState, line, {
      sessionProjectDirs,
    });
  if (!event) {
    return;
  }

  if (event.eventType !== "require_escalated_tool_call") {
    emitCodexApprovalNotification({
      event,
      runtime,
      terminal,
      emittedEventKeys,
      origin: "tui",
    });
    return;
  }

  const approvalContext = sessionApprovalContexts.get(event.sessionId || "");
  const suppressionReason = getCodexRequireEscalatedSuppressionReason({
    event,
    approvalPolicy: approvalContext && approvalContext.approvalPolicy,
    sandboxPolicy: approvalContext && approvalContext.sandboxPolicy,
    approvedCommandRules: getApprovedCommandRules(approvedCommandRuleCache, runtime.log),
  });

  if (suppressionReason) {
    runtime.log(
      `suppressed tui require_escalated sessionId=${event.sessionId || "unknown"} turnId=${event.turnId || ""} reason=${suppressionReason}`
    );
    return;
  }

  const sessionSuppressionReason = getSessionRequireEscalatedSuppressionReason({
    event,
    sessionApprovalGrants,
  });
  if (sessionSuppressionReason) {
    runtime.log(
      `suppressed tui require_escalated sessionId=${event.sessionId || "unknown"} turnId=${event.turnId || ""} reason=${sessionSuppressionReason}`
    );
    return;
  }

  rememberRecentRequireEscalatedEvent(recentRequireEscalatedEvents, event);

  queuePendingApprovalNotification({
    runtime,
    pendingApprovalNotifications,
    pendingApprovalCallIds,
    emittedEventKeys,
    event,
  });
}

function buildCodexSessionEvent(state, record) {
  const payload = record && record.payload;
  if (!payload || typeof payload.type !== "string") {
    return null;
  }

  const sessionId = state.sessionId || parseSessionIdFromRolloutPath(state.filePath) || "unknown";
  const projectDir = payload.cwd || state.cwd || "";
  const turnId = payload.turn_id || state.turnId || "";
  const callId = payload.call_id || "";
  const approvalId = payload.approval_id || "";

  if (record.type === "response_item" && payload.type === "function_call") {
    const args = parseJsonObjectMaybe(payload.arguments);
    if (payload.name === "request_user_input" && args) {
      const descriptor = getCodexInputRequestDescriptor(args);
      return {
        ...createNotificationSpec({
          sourceId: "codex-session-watch",
          sessionId,
          turnId,
          eventName: "InputRequest",
          projectDir,
          rawEventType: payload.name,
          message: getCodexInputRequestMessage(args),
        }),
        eventType: payload.name,
        callId,
        dedupeKey: buildApprovalDedupeKey({
          sessionId,
          turnId,
          callId,
          approvalKind: "input",
          descriptor,
        }),
      };
    }

    if (!args || args.sandbox_permissions !== "require_escalated") {
      return null;
    }

    const descriptor = getCodexExecApprovalDescriptor(payload.name, args);
    const approvalProjectDir = args.workdir || projectDir;
    return {
      ...createNotificationSpec({
        sourceId: "codex-session-watch",
        sessionId,
        turnId,
        eventName: "PermissionRequest",
        projectDir: approvalProjectDir,
        rawEventType: "require_escalated_tool_call",
      }),
      eventType: "require_escalated_tool_call",
      approvalDispatch: "pending",
      callId,
      toolArgs: args,
      dedupeKey: buildApprovalDedupeKey({
        sessionId,
        turnId,
        callId,
        approvalKind: "exec",
        descriptor,
      }),
    };
  }

  if (record.type !== "event_msg") {
    return null;
  }

  switch (payload.type) {
    case "exec_approval_request":
    case "request_permissions":
      return {
        ...createNotificationSpec({
          sourceId: "codex-session-watch",
          sessionId,
          turnId,
          eventName: "PermissionRequest",
          projectDir,
          rawEventType: payload.type,
        }),
        eventType: payload.type,
        dedupeKey: buildApprovalDedupeKey({
          sessionId,
          turnId,
          callId,
          approvalId,
          approvalKind: "exec",
        }),
      };
    case "apply_patch_approval_request":
      return {
        ...createNotificationSpec({
          sourceId: "codex-session-watch",
          sessionId,
          turnId,
          eventName: "PermissionRequest",
          projectDir,
          rawEventType: payload.type,
        }),
        eventType: payload.type,
        dedupeKey: buildApprovalDedupeKey({
          sessionId,
          turnId,
          callId,
          approvalId,
          approvalKind: "patch",
        }),
      };
    default:
      return null;
  }
}

function parseCodexTuiToolCallLine(line) {
  if (!line || !line.includes("ToolCall: ")) {
    return null;
  }

  const match = line.match(
    /thread_id=([^}:]+).*?submission\.id="([^"]+)".*?(?:turn\.id=([^ ]+).*?)?ToolCall: ([^ ]+) (\{.*\}) thread_id=/
  );

  if (!match) {
    return null;
  }

  const [, sessionId, submissionId, turnIdFromLog, toolName, rawArgs] = match;
  const args = parseJsonObjectMaybe(rawArgs);
  if (!args) {
    return null;
  }

  return {
    sessionId,
    submissionId,
    turnId: turnIdFromLog || submissionId,
    toolName,
    args,
  };
}

function buildCodexTuiApprovalEvent(tuiState, line, { sessionProjectDirs, sessionApprovalContexts }) {
  if (!line.includes('"sandbox_permissions":"require_escalated"')) {
    return null;
  }

  const toolCall = parseCodexTuiToolCallLine(line);
  if (!toolCall || toolCall.toolName !== "shell_command") {
    return null;
  }

  const { sessionId, submissionId, turnId, args } = toolCall;
  if (!args || args.sandbox_permissions !== "require_escalated") {
    return null;
  }

  const projectDir = args.workdir || sessionProjectDirs.get(sessionId) || "";
  const descriptor = getCodexExecApprovalDescriptor("shell_command", args);

  return {
    ...createNotificationSpec({
      sourceId: "codex-session-watch",
      sessionId,
      turnId,
      eventName: "PermissionRequest",
      projectDir,
      rawEventType: "require_escalated_tool_call",
    }),
    eventType: "require_escalated_tool_call",
    approvalDispatch: "pending",
    approvalPolicy:
      sessionApprovalContexts && sessionApprovalContexts.get(sessionId)
        ? sessionApprovalContexts.get(sessionId).approvalPolicy || ""
        : "",
    callId: "",
    toolArgs: args,
    dedupeKey: buildApprovalDedupeKey({
      sessionId,
      turnId,
      fallbackId: submissionId,
      approvalKind: "exec",
      descriptor,
    }),
  };
}

function buildCodexTuiInputEvent(tuiState, line, { sessionProjectDirs }) {
  const toolCall = parseCodexTuiToolCallLine(line);
  if (!toolCall || toolCall.toolName !== "request_user_input") {
    return null;
  }

  const { sessionId, submissionId, turnId, args } = toolCall;
  const descriptor = getCodexInputRequestDescriptor(args);

  return {
    ...createNotificationSpec({
      sourceId: "codex-session-watch",
      sessionId,
      turnId,
      eventName: "InputRequest",
      projectDir: sessionProjectDirs.get(sessionId) || "",
      rawEventType: "request_user_input",
      message: getCodexInputRequestMessage(args),
    }),
    eventType: "request_user_input",
    dedupeKey: buildApprovalDedupeKey({
      sessionId,
      turnId,
      fallbackId: submissionId,
      approvalKind: "input",
      descriptor,
    }),
  };
}

function parseCodexTuiApprovalConfirmation(line) {
  if (!line || !line.includes("thread_id=")) {
    return null;
  }

  let source = "";
  if (line.includes('otel.name="op.dispatch.exec_approval"')) {
    source = "tui_exec_approval";
  } else if (line.includes('otel.name="op.dispatch.patch_approval"')) {
    source = "tui_patch_approval";
  } else {
    return null;
  }

  const match = line.match(/thread_id=([^}:]+)/);
  if (!match) {
    return null;
  }

  return {
    sessionId: match[1],
    source,
  };
}

function isApprovedCommandRuleSavedRecord(record) {
  if (
    !record ||
    record.type !== "response_item" ||
    !record.payload ||
    record.payload.type !== "message" ||
    record.payload.role !== "developer" ||
    !Array.isArray(record.payload.content)
  ) {
    return false;
  }

  return record.payload.content.some(
    (item) =>
      item &&
      item.type === "input_text" &&
      typeof item.text === "string" &&
      item.text.startsWith("Approved command prefix saved:")
  );
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

function pruneEmittedEventKeys(emittedEventKeys, maxSize) {
  while (emittedEventKeys.size > maxSize) {
    const firstKey = emittedEventKeys.keys().next();
    if (firstKey.done) {
      return;
    }
    emittedEventKeys.delete(firstKey.value);
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = {
  buildCodexSessionEvent,
  buildCodexTuiApprovalEvent,
  buildCodexTuiInputEvent,
  buildApprovalDedupeKey,
  buildPendingApprovalBatchKey,
  cancelPendingApprovalNotificationsBySuppression,
  confirmSessionApprovalForRecentEvents,
  drainPendingApprovalBatch,
  extractCommandApprovalRoots,
  getCodexApprovalNotifyGraceMs,
  getCodexInputRequestDescriptor,
  getCodexRequireEscalatedSuppressionReason,
  getSessionRequireEscalatedSuppressionReason,
  handleMcpServerMessage,
  isLikelyReadOnlyShellCommand,
  matchesApprovedCommandRule,
  rememberRecentRequireEscalatedEvent,
  getCodexExecApprovalDescriptor,
  parseApprovedCommandRules,
  parseJsonObjectMaybe,
  parseRolloutTimestampFromPath,
  pickSidecarSessionCandidate,
  resolveSidecarSessionCandidate,
  resolveApprovalTerminalContext,
  shouldBatchPendingApproval,
};
