#!/usr/bin/env node

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { StringDecoder } = require("string_decoder");
const {
  createNotificationSpec,
  normalizeIncomingNotification,
} = require("../lib/notification-sources");

const PACKAGE_VERSION = readPackageVersion();
const LOG_DIR = path.join(os.tmpdir(), "claude-code-notify");
const IS_DEV = !fs.existsSync(path.join(__dirname, "..", ".published"));

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
    throw new Error("claude-code-notify currently only supports Windows.");
  }
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === "codex" || argv[0] === "codex-watch" || argv[0] === "--codex-watch") {
    await runCodexWatchMode(argv[0] === "--codex-watch" ? argv.slice(1) : argv.slice(1));
    return;
  }

  if (argv[0] === "codex-session-watch" || argv[0] === "--codex-session-watch") {
    await runCodexSessionWatchMode(
      argv[0] === "--codex-session-watch" ? argv.slice(1) : argv.slice(1)
    );
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
      "  claude-code-notify",
      "  claude-code-notify codex-watch [--all-cwds] [--cwd <path>] [--codex-bin <path>]",
      "  claude-code-notify codex-session-watch [--sessions-dir <path>] [--tui-log <path>] [--poll-ms <ms>]",
      "",
      "Modes:",
      "  default      Read notification JSON from stdin or argv and show a notification",
      "  codex-watch  Start the official `codex app-server` and notify when a thread enters waitingOnApproval",
      "  codex-session-watch  Watch local Codex rollout files and TUI logs for approval events",
      "",
      "Flags:",
      "  --shell-pid <pid>  Override the detected shell pid",
      "  --all-cwds         Watch Codex threads from every cwd instead of only the current cwd",
      "  --cwd <path>       Filter Codex threads to a specific cwd",
      "  --codex-bin <bin>  Override the Codex executable path",
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

async function runCodexWatchMode(argv) {
  if (argv[0] === "--help" || argv[0] === "help") {
    printHelp();
    return;
  }

  const watchCwd = getArgValue(argv, "--cwd") || process.cwd();
  const watchAllCwds = hasFlag(argv, "--all-cwds");
  const codexBin =
    getArgValue(argv, "--codex-bin") ||
    getEnvFirst(["TOAST_NOTIFY_CODEX_BIN"]) ||
    "codex";

  const runtime = createRuntime(`codex-watch-${Date.now()}`);
  const terminal = detectTerminalContext(argv, runtime.log);
  const approvalState = new Map();
  const threadProjectDirs = new Map();
  const pendingRequests = new Map();

  let requestCounter = 0;
  let bootstrapSent = false;
  let initializeObserved = false;

  runtime.log(
    `started mode=codex-watch cwd=${watchCwd} watchAllCwds=${watchAllCwds ? "1" : "0"} codexBin=${codexBin}`
  );

  const codexLaunch = resolveCodexLaunch(codexBin, runtime.log);
  runtime.log(
    `resolved codex launcher command=${codexLaunch.command} args=${safeStringify(codexLaunch.args)}`
  );

  const codex = spawn(codexLaunch.command, codexLaunch.args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
    windowsVerbatimArguments: codexLaunch.windowsVerbatimArguments === true,
  });

  codex.on("error", (error) => {
    runtime.log(`codex app-server spawn failed: ${error.message}`);
    process.exit(1);
  });

  codex.on("close", (code, signal) => {
    runtime.log(`codex app-server exited code=${code} signal=${signal || ""}`.trim());
    process.exit(code || 0);
  });

  const reader = readline.createInterface({
    input: codex.stdout,
    crlfDelay: Infinity,
  });

  reader.on("line", (line) => {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      runtime.log(`failed to parse app-server line: ${error.message}`);
      return;
    }

    handleServerMessage(message);
  });

  sendRequest("initialize", {
    clientInfo: {
      name: "claude-code-notify",
      title: "claude-code-notify",
      version: PACKAGE_VERSION,
    },
    capabilities: null,
  });

  setTimeout(() => {
    if (!initializeObserved) {
      runtime.log("initialize response not observed; continuing optimistically");
      sendInitializedAndBootstrap();
    }
  }, 500);

  function handleServerMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      handleResponse(message);
      return;
    }

    if (!message || typeof message.method !== "string") {
      runtime.log("ignored app-server message without method");
      return;
    }

    switch (message.method) {
      case "thread/started":
        if (message.params && message.params.thread) {
          rememberThread(message.params.thread);
        }
        return;
      case "thread/status/changed":
        if (message.params && message.params.threadId) {
          updateApprovalState(message.params.threadId, message.params.status);
        }
        return;
      case "thread/closed":
      case "thread/archived":
        if (message.params && message.params.threadId) {
          approvalState.delete(message.params.threadId);
          threadProjectDirs.delete(message.params.threadId);
        }
        return;
      default:
        return;
    }
  }

  function handleResponse(message) {
    const requestId = String(message.id);
    const pending = pendingRequests.get(requestId);

    if (!pending) {
      return;
    }

    pendingRequests.delete(requestId);

    if (message.error) {
      runtime.log(
        `request failed method=${pending.method} id=${requestId} error=${safeStringify(message.error)}`
      );
      if (pending.method === "initialize") {
        process.exit(1);
      }
      return;
    }

    if (pending.method === "initialize") {
      initializeObserved = true;
      sendInitializedAndBootstrap();
      return;
    }

    const result = Object.prototype.hasOwnProperty.call(message, "result")
      ? message.result
      : null;

    if (pending.method === "thread/list" && result && Array.isArray(result.data)) {
      result.data.forEach(rememberThread);
      if (result.nextCursor) {
        requestThreadList(result.nextCursor);
      }
    }
  }

  function sendInitializedAndBootstrap() {
    if (bootstrapSent) {
      return;
    }

    bootstrapSent = true;
    sendNotification({ method: "initialized" });
    requestThreadList(null);
  }

  function requestThreadList(cursor) {
    const params = {
      archived: false,
      sortKey: "updated_at",
      limit: 100,
    };

    if (cursor) {
      params.cursor = cursor;
    }

    if (!watchAllCwds) {
      params.cwd = watchCwd;
    }

    sendRequest("thread/list", params);
  }

  function rememberThread(thread) {
    if (!thread || !thread.id) {
      return;
    }

    if (thread.cwd) {
      threadProjectDirs.set(thread.id, thread.cwd);
    }

    updateApprovalState(thread.id, thread.status);
  }

  function updateApprovalState(threadId, status) {
    const waiting = isWaitingOnApproval(status);
    const previous = approvalState.get(threadId) === true;

    if (waiting) {
      approvalState.set(threadId, true);
      if (!previous) {
        const projectDir = threadProjectDirs.get(threadId) || watchCwd;
        const notification = createNotificationSpec({
          sourceId: "codex-app-server",
          eventName: "PermissionRequest",
          projectDir,
        });
        runtime.log(`approval requested threadId=${threadId} cwd=${projectDir}`);
        const child = emitNotification({
          source: notification.source,
          eventName: notification.eventName,
          title: notification.title,
          message: notification.message,
          rawEventType: "waitingOnApproval",
          runtime,
          terminal,
        });
        child.on("close", (code) => {
          runtime.log(`notify.ps1 exited code=${code} threadId=${threadId}`);
        });
        child.on("error", (error) => {
          runtime.log(`notify.ps1 spawn failed threadId=${threadId} error=${error.message}`);
        });
      }
      return;
    }

    if (previous) {
      runtime.log(`approval cleared threadId=${threadId}`);
    }

    approvalState.delete(threadId);
  }

  function sendRequest(method, params) {
    const id = `req-${++requestCounter}`;
    pendingRequests.set(id, { method });
    sendMessage({ id, method, params });
  }

  function sendNotification(message) {
    sendMessage(message);
  }

  function sendMessage(message) {
    runtime.log(`app-server <= ${message.method}${message.id ? ` id=${message.id}` : ""}`);
    codex.stdin.write(`${JSON.stringify(message)}\n`);
  }
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
  const terminal = createNeutralTerminalContext();
  const fileStates = new Map();
  const sessionProjectDirs = new Map();
  const emittedEventKeys = new Map();
  let tuiLogState = null;
  let initialScan = true;
  let scanInProgress = false;

  runtime.log(
    `started mode=codex-session-watch sessionsDir=${sessionsDir} tuiLogPath=${tuiLogPath} pollMs=${pollMs}`
  );

  if (!fileExistsCaseInsensitive(sessionsDir)) {
    runtime.log(`sessions dir not found yet: ${sessionsDir}`);
  }

  if (!fileExistsCaseInsensitive(tuiLogPath)) {
    runtime.log(`tui log not found yet: ${tuiLogPath}`);
  }

  const interval = setInterval(scanOnce, pollMs);

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  scanOnce();
  initialScan = false;

  function shutdown(signal) {
    clearInterval(interval);
    runtime.log(`stopped mode=codex-session-watch signal=${signal}`);
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
        });

        if (state.sessionId && state.cwd) {
          sessionProjectDirs.set(state.sessionId, state.cwd);
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
      });

      pruneEmittedEventKeys(emittedEventKeys, 4096);
    } catch (error) {
      runtime.log(`session scan failed: ${error.message}`);
    } finally {
      scanInProgress = false;
    }
  }
}

function createRuntime(logId) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `${logId}.log`);

  function log(message) {
    const line = `[${new Date().toISOString()}] [node pid=${process.pid}] ${message}\n`;
    process.stderr.write(line);
    try {
      fs.appendFileSync(logFile, line);
    } catch {}
  }

  return {
    isDev: IS_DEV,
    logFile,
    log,
  };
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

function hasFlag(argv, name) {
  return argv.includes(name);
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

function getCodexHomeDir() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function createNeutralTerminalContext() {
  return {
    hwnd: null,
    shellPid: null,
    isWindowsTerminal: false,
  };
}

function stripUtf8Bom(value) {
  return typeof value === "string" ? value.replace(/^\uFEFF/, "") : value;
}

function getExplicitShellPid(argv) {
  const raw =
    getArgValue(argv, "--shell-pid") ||
    getEnvFirst(["TOAST_NOTIFY_SHELL_PID"]) ||
    "";
  const pid = parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function resolveCodexLaunch(rawCommand, log) {
  const resolved = resolveWindowsCommand(rawCommand, log);
  const ext = resolved ? path.extname(resolved).toLowerCase() : "";

  if (ext === ".cmd" || ext === ".bat") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${resolved}" app-server`],
      windowsVerbatimArguments: true,
    };
  }

  return {
    command: resolved || rawCommand,
    args: ["app-server"],
    windowsVerbatimArguments: false,
  };
}

function resolveWindowsCommand(rawCommand, log) {
  if (!rawCommand) {
    return "";
  }

  const explicit = resolveExplicitCommandPath(rawCommand);
  if (explicit) {
    return explicit;
  }

  const whereMatches = findCommandWithWhere(rawCommand, log);
  if (whereMatches.length > 0) {
    return whereMatches[0];
  }

  const fallbackMatches = getFallbackCommandCandidates(rawCommand).filter((candidate) =>
    fileExistsCaseInsensitive(candidate)
  );
  if (fallbackMatches.length > 0) {
    return sortCommandCandidates(fallbackMatches)[0];
  }

  return rawCommand;
}

function resolveExplicitCommandPath(rawCommand) {
  const looksLikePath =
    rawCommand.includes("\\") ||
    rawCommand.includes("/") ||
    /^[A-Za-z]:/.test(rawCommand);

  if (!looksLikePath) {
    return "";
  }

  const candidates = expandCommandCandidates(rawCommand);
  const match = candidates.find((candidate) => fileExistsCaseInsensitive(candidate));
  return match || "";
}

function findCommandWithWhere(rawCommand, log) {
  const result = spawnSync("where.exe", [rawCommand], {
    encoding: "utf8",
    env: process.env,
  });

  if (result.error) {
    log(`where.exe failed for ${rawCommand}: ${result.error.message}`);
    return [];
  }

  return sortCommandCandidates(
    (result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((candidate) => fileExistsCaseInsensitive(candidate))
  );
}

function getFallbackCommandCandidates(rawCommand) {
  const baseName = path.basename(rawCommand);
  const localAppData = process.env.LOCALAPPDATA || "";
  const appData = process.env.APPDATA || "";

  return sortCommandCandidates(
    [
      path.join(localAppData, "Volta", "bin", baseName),
      path.join(appData, "npm", baseName),
      ...expandCommandCandidates(path.join(localAppData, "Volta", "bin", baseName)),
      ...expandCommandCandidates(path.join(appData, "npm", baseName)),
    ].filter(Boolean)
  );
}

function expandCommandCandidates(commandPath) {
  const ext = path.extname(commandPath);
  if (ext) {
    return [commandPath];
  }

  return [commandPath, `${commandPath}.exe`, `${commandPath}.cmd`, `${commandPath}.bat`];
}

function sortCommandCandidates(candidates) {
  const unique = Array.from(new Set(candidates.map((candidate) => path.normalize(candidate))));
  const extPriority = {
    ".exe": 0,
    ".cmd": 1,
    ".bat": 2,
    "": 3,
  };

  return unique.sort((left, right) => {
    const leftExt = path.extname(left).toLowerCase();
    const rightExt = path.extname(right).toLowerCase();
    const leftRank = Object.prototype.hasOwnProperty.call(extPriority, leftExt)
      ? extPriority[leftExt]
      : 9;
    const rightRank = Object.prototype.hasOwnProperty.call(extPriority, rightExt)
      ? extPriority[rightExt]
      : 9;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return left.localeCompare(right);
  });
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
  };

  try {
    const stat = fs.statSync(filePath);
    if (!stat.size) {
      return result;
    }

    const bytesToRead = Math.min(stat.size, 65536);
    const buffer = readFileRange(filePath, 0, bytesToRead);
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

      if (record.type === "session_meta" && record.payload) {
        if (record.payload.id) {
          result.sessionId = record.payload.id;
        }
        if (record.payload.cwd) {
          result.cwd = record.payload.cwd;
        }
      }

      if (!result.cwd && record.type === "turn_context" && record.payload && record.payload.cwd) {
        result.cwd = record.payload.cwd;
      }

      if (result.sessionId && result.cwd) {
        break;
      }
    }
  } catch (error) {
    log(`metadata read failed file=${filePath} error=${error.message}`);
  }

  return result;
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

function consumeSessionFileUpdates(state, stat, { runtime, terminal, emittedEventKeys }) {
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
  { runtime, terminal, emittedEventKeys, sessionProjectDirs }
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


function handleSessionRecord(state, line, { runtime, terminal, emittedEventKeys }) {
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

  if (!shouldEmitEventKey(emittedEventKeys, event.dedupeKey)) {
    return;
  }

  runtime.log(
    `session event matched type=${event.eventType} sessionId=${event.sessionId || "unknown"} turnId=${event.turnId || ""} cwd=${event.projectDir || ""}`
  );

  const child = emitNotification({
    source: event.source,
    eventName: event.eventName,
    title: event.title,
    message: event.message,
    rawEventType: event.eventType,
    runtime,
    terminal,
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
}

function handleCodexTuiLogLine(
  tuiState,
  line,
  { runtime, terminal, emittedEventKeys, sessionProjectDirs }
) {
  if (!line || !line.trim()) {
    return;
  }

  const event = buildCodexTuiApprovalEvent(tuiState, line, {
    sessionProjectDirs,
  });
  if (!event) {
    return;
  }

  if (!shouldEmitEventKey(emittedEventKeys, event.dedupeKey)) {
    return;
  }

  runtime.log(
    `tui approval matched type=${event.eventType} sessionId=${event.sessionId || "unknown"} cwd=${event.projectDir || ""}`
  );

  const child = emitNotification({
    source: event.source,
    eventName: event.eventName,
    title: event.title,
    message: event.message,
    rawEventType: event.eventType,
    runtime,
    terminal,
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

function buildCodexTuiApprovalEvent(tuiState, line, { sessionProjectDirs }) {
  if (!line.includes("ToolCall: shell_command ") || !line.includes('"sandbox_permissions":"require_escalated"')) {
    return null;
  }

  const match = line.match(
    /thread_id=([^}:]+).*?submission\.id="([^"]+)".*?(?:turn\.id=([^ ]+).*?)?ToolCall: shell_command (\{.*\}) thread_id=/
  );

  if (!match) {
    return null;
  }

  const [, sessionId, submissionId, turnIdFromLog, rawArgs] = match;
  const args = parseJsonObjectMaybe(rawArgs);
  if (!args || args.sandbox_permissions !== "require_escalated") {
    return null;
  }

  const turnId = turnIdFromLog || submissionId;
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
    dedupeKey: buildApprovalDedupeKey({
      sessionId,
      turnId,
      fallbackId: submissionId,
      approvalKind: "exec",
      descriptor,
    }),
  };
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

function pruneEmittedEventKeys(emittedEventKeys, maxSize) {
  while (emittedEventKeys.size > maxSize) {
    const firstKey = emittedEventKeys.keys().next();
    if (firstKey.done) {
      return;
    }
    emittedEventKeys.delete(firstKey.value);
  }
}

function detectShellPid(log) {
  const detectScript = path.join(__dirname, "..", "scripts", "get-shell-pid.ps1");
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      detectScript,
      "-StartPid",
      String(process.pid),
    ],
    { encoding: "utf8" }
  );

  writeChildStderr(result, log);

  const pid = parseInt((result.stdout || "").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function findParentInfo(log) {
  const findScript = path.join(__dirname, "..", "scripts", "find-hwnd.ps1");
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      findScript,
      "-StartPid",
      String(process.pid),
      "-IncludeShellPid",
    ],
    { encoding: "utf8" }
  );

  writeChildStderr(result, log);

  const parts = (result.stdout || "").trim().split("|");
  const hwnd = parseInt(parts[0], 10);
  const shellPid = parseInt(parts[1], 10);
  const isWindowsTerminal = parts[2] === "1";

  return {
    hwnd: hwnd > 0 ? hwnd : null,
    shellPid: shellPid > 0 ? shellPid : null,
    isWindowsTerminal,
  };
}

function detectTerminalContext(argv, log) {
  const parentInfo = findParentInfo(log);
  const shellPid = getExplicitShellPid(argv) || detectShellPid(log) || parentInfo.shellPid;

  if (!shellPid) {
    log("no shell pid detected; tab color watcher disabled");
  }

  return {
    hwnd: parentInfo.hwnd,
    shellPid,
    isWindowsTerminal: parentInfo.isWindowsTerminal,
  };
}

function emitNotification({ source, eventName, title, message, rawEventType, runtime, terminal }) {
  const envVars = {
    PATH: process.env.PATH || "",
    PATHEXT: process.env.PATHEXT || "",
    TOAST_NOTIFY_EVENT: eventName,
    TOAST_NOTIFY_IS_DEV: runtime.isDev ? "1" : "0",
    TOAST_NOTIFY_LOG_FILE: runtime.logFile,
  };

  if (source) {
    envVars.TOAST_NOTIFY_SOURCE = source;
  }

  if (title) {
    envVars.TOAST_NOTIFY_TITLE = title;
  }

  if (message) {
    envVars.TOAST_NOTIFY_MESSAGE = message;
  }

  if (rawEventType) {
    envVars.TOAST_NOTIFY_RAW_EVENT = rawEventType;
  }

  if (terminal.hwnd) {
    envVars.TOAST_NOTIFY_HWND = String(terminal.hwnd);
  }

  writeWindowsTerminalColor(eventName, terminal, runtime.log);
  startTabColorWatcher({
    eventName,
    runtime,
    terminal,
  });

  const scriptPath = path.join(__dirname, "..", "scripts", "notify.ps1");
  return spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { stdio: ["ignore", "inherit", "inherit"], env: envVars }
  );
}

function writeWindowsTerminalColor(eventName, terminal, log) {
  if (!terminal || !terminal.isWindowsTerminal) {
    return;
  }

  const colorMap = {
    Stop: "rgb:33/cc/33",
    PermissionRequest: "rgb:ff/99/00",
  };
  const tabColor = colorMap[eventName];

  if (!tabColor) {
    return;
  }

  const oscSet = `\x1b]4;264;${tabColor}\x1b\\`;

  try {
    if (process.stdout && !process.stdout.destroyed) {
      process.stdout.write(oscSet);
    }
    if (process.stderr && !process.stderr.destroyed) {
      process.stderr.write(oscSet);
    }
  } catch (error) {
    log(`initial tab color write failed: ${error.message}`);
  }
}

function startTabColorWatcher({ eventName, runtime, terminal }) {
  if (!terminal.isWindowsTerminal) {
    return;
  }

  if (!terminal.shellPid) {
    runtime.log("tab color watcher not started because no shell pid was detected");
    return;
  }

  try {
    const launcherScript = path.join(
      __dirname,
      "..",
      "scripts",
      "start-tab-color-watcher.ps1"
    );
    const watcherPidFile = path.join(
      LOG_DIR,
      `watcher-${process.pid}-${Date.now()}.pid`
    );
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcherScript,
        "-TargetPid",
        String(terminal.shellPid),
        "-HookEvent",
        eventName,
        ...(terminal.hwnd ? ["-TerminalHwnd", String(terminal.hwnd)] : []),
        "-WatcherPidFile",
        watcherPidFile,
      ],
      {
        stdio: ["ignore", "ignore", "ignore"],
        env: {
          ...process.env,
          TOAST_NOTIFY_LOG_FILE: runtime.logFile,
        },
      }
    );

    if (result.error) {
      throw result.error;
    }

    const watcherPidRaw = fs.existsSync(watcherPidFile)
      ? fs.readFileSync(watcherPidFile, "utf8").trim()
      : "";

    try {
      if (fs.existsSync(watcherPidFile)) {
        fs.unlinkSync(watcherPidFile);
      }
    } catch {}

    const watcherPid = parseInt(watcherPidRaw, 10);
    if (result.status === 0 && Number.isInteger(watcherPid) && watcherPid > 0) {
      runtime.log(
        `tab-color-watcher spawned pid=${watcherPid} shellPid=${terminal.shellPid}`
      );
    } else {
      runtime.log(
        `tab-color-watcher launcher exited status=${result.status} without child pid shellPid=${terminal.shellPid}`
      );
    }
  } catch (error) {
    runtime.log(`tab-color-watcher spawn failed: ${error.message}`);
  }
}

function isWaitingOnApproval(status) {
  return (
    status &&
    status.type === "active" &&
    Array.isArray(status.activeFlags) &&
    status.activeFlags.includes("waitingOnApproval")
  );
}

function writeChildStderr(result, log) {
  if (!result || !result.stderr) {
    return;
  }

  result.stderr
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .forEach((line) => log(line));
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
  buildApprovalDedupeKey,
  getCodexExecApprovalDescriptor,
  parseJsonObjectMaybe,
};
