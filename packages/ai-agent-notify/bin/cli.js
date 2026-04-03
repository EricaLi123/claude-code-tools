#!/usr/bin/env node

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const {
  parseRolloutTimestampFromPath,
  pickSidecarSessionCandidate,
  resolveSidecarSessionCandidate: resolveSidecarSessionCandidateCore,
  startSidecarSessionResolver,
} = require("../lib/codex-sidecar-resolver");
const { writeSidecarRecord } = require("../lib/codex-sidecar-state");
const {
  buildPendingApprovalBatchKey,
  cancelPendingApprovalNotificationsBySuppression,
  confirmSessionApprovalForRecentEvents,
  createApprovedCommandRuleCache,
  drainPendingApprovalBatch,
  extractCommandApprovalRoots,
  flushPendingApprovalNotifications,
  getCodexApprovalNotifyGraceMs,
  getCodexRequireEscalatedSuppressionReason,
  getSessionRequireEscalatedSuppressionReason,
  isLikelyReadOnlyShellCommand,
  matchesApprovedCommandRule,
  parseApprovedCommandRules,
  rememberRecentRequireEscalatedEvent,
  resolveApprovalTerminalContext,
  shouldBatchPendingApproval,
} = require("../lib/codex-approval");
const {
  buildApprovalDedupeKey,
  buildCodexSessionEvent,
  buildCodexTuiApprovalEvent,
  buildCodexTuiInputEvent,
  getCodexExecApprovalDescriptor,
  getCodexInputRequestDescriptor,
  parseJsonObjectMaybe,
} = require("../lib/codex-session-events");
const {
  bootstrapExistingSessionFileState,
  consumeSessionFileUpdates,
  createSessionFileState,
  listRolloutFiles,
  pruneEmittedEventKeys,
  readRolloutMetadata,
  syncCodexTuiLogState,
} = require("../lib/codex-session-watch");
const {
  LOG_DIR,
  createNeutralTerminalContext,
  createRuntime,
  detectTerminalContext,
  emitNotification,
  findParentInfo,
} = require("../lib/notify-runtime");
const {
  fileExistsCaseInsensitive,
  getArgValue,
  getEnvFirst,
  parsePositiveInteger,
  stripUtf8Bom,
} = require("../lib/shared-utils");
const { normalizeIncomingNotification } = require("../lib/notification-sources");

const PACKAGE_VERSION = readPackageVersion();

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

function resolveSidecarSessionCandidate(args) {
  return resolveSidecarSessionCandidateCore({
    ...args,
    fileExistsCaseInsensitive,
    listRolloutFiles,
    readRolloutMetadata,
  });
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
