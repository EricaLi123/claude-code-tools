const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createApprovedCommandRuleCache } = require("./codex-approval-rules");
const { flushPendingApprovalNotifications } = require("./codex-approval-pending");
const {
  bootstrapExistingSessionFileState,
  createSessionFileState,
  listRolloutFiles,
} = require("./codex-session-watch-files");
const {
  consumeSessionFileUpdates,
  pruneEmittedEventKeys,
  syncCodexTuiLogState,
} = require("./codex-session-watch-streams");
const { LOG_DIR, createNeutralTerminalContext, createRuntime } = require("./notify-runtime");
const {
  fileExistsCaseInsensitive,
  getArgValue,
  getEnvFirst,
  parsePositiveInteger,
} = require("./shared-utils");

async function runCodexSessionWatchMode(argv) {
  if (argv[0] === "--help" || argv[0] === "help") {
    return { handledHelp: true };
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
    return { handledHelp: false };
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
    `started mode=codex-session-watch sessionsDir=${sessionsDir} tuiLogPath=${tuiLogPath} pollMs=${pollMs} packageRoot=${runtime.buildInfo.packageRoot}`
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

  return { handledHelp: false };
}

function ensureCodexSessionWatchRunning({ cliPath, log, watcherArgs = [] }) {
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

  const child = launchCodexSessionWatchHidden({ cliPath, watcherArgs, log });
  return {
    launched: true,
    pid: child && child.pid ? child.pid : null,
    lockPath: state.lockPath,
  };
}

function launchCodexSessionWatchHidden({ cliPath, watcherArgs, log }) {
  const launchArgs = buildCodexSessionWatchLaunchArgs({ cliPath, watcherArgs });
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
    [path.resolve(cliPath), "codex-session-watch", ...watcherArgs],
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

function buildCodexSessionWatchLaunchArgs({ cliPath, watcherArgs }) {
  const extraArgs = Array.isArray(watcherArgs) ? watcherArgs : [];
  return [process.execPath, path.resolve(cliPath), "codex-session-watch", ...extraArgs];
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

module.exports = {
  ensureCodexSessionWatchRunning,
  runCodexSessionWatchMode,
};
