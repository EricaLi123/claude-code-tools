#!/usr/bin/env node

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

if (process.platform !== "win32") {
  console.error("claude-code-notify currently only supports Windows.");
  process.exit(1);
}

const PACKAGE_VERSION = readPackageVersion();
const LOG_DIR = path.join(os.tmpdir(), "claude-code-notify");
const IS_DEV = !fs.existsSync(path.join(__dirname, "..", ".published"));

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === "codex" || argv[0] === "codex-watch" || argv[0] === "--codex-watch") {
    await runCodexWatchMode(argv[0] === "--codex-watch" ? argv.slice(1) : argv.slice(1));
    return;
  }

  if (argv[0] === "--help" || argv[0] === "help") {
    printHelp();
    return;
  }

  await runClaudeHookMode(argv);
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  claude-code-notify",
      "  claude-code-notify codex-watch [--all-cwds] [--cwd <path>] [--codex-bin <path>]",
      "",
      "Modes:",
      "  default      Read Claude Code hook JSON from stdin and show a notification",
      "  codex-watch  Start the official `codex app-server` and notify when a thread enters waitingOnApproval",
      "",
      "Flags:",
      "  --shell-pid <pid>  Override the detected shell pid",
      "  --all-cwds         Watch Codex threads from every cwd instead of only the current cwd",
      "  --cwd <path>       Filter Codex threads to a specific cwd",
      "  --codex-bin <bin>  Override the Codex executable path",
      "",
    ].join(os.EOL)
  );
}

async function runClaudeHookMode(argv) {
  const stdinData = readStdin();
  let hookJson = null;

  try {
    hookJson = JSON.parse(stdinData);
  } catch {}

  const sessionId = hookJson && hookJson.session_id ? hookJson.session_id : "unknown";
  const runtime = createRuntime(sessionId);
  const terminal = detectTerminalContext(argv, runtime.log);

  runtime.log(`started mode=claude-hook session=${sessionId}`);

  const eventName = (hookJson && hookJson.hook_event_name) || "";
  const customTitle = (hookJson && hookJson.title) || "";
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";

  const child = emitNotification({
    eventName,
    customTitle,
    projectDir,
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
    process.env.CLAUDE_NOTIFY_CODEX_BIN ||
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
        runtime.log(`approval requested threadId=${threadId} cwd=${projectDir}`);
        const child = emitNotification({
          eventName: "PermissionRequest",
          customTitle: "Codex Needs Approval",
          projectDir,
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

function getExplicitShellPid(argv) {
  const raw = getArgValue(argv, "--shell-pid") || process.env.CLAUDE_NOTIFY_SHELL_PID || "";
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

function emitNotification({ eventName, customTitle, projectDir, runtime, terminal }) {
  const envVars = {
    PATH: process.env.PATH || "",
    PATHEXT: process.env.PATHEXT || "",
    CLAUDE_NOTIFY_EVENT: eventName,
    CLAUDE_NOTIFY_IS_DEV: runtime.isDev ? "1" : "0",
    CLAUDE_NOTIFY_LOG_FILE: runtime.logFile,
    CLAUDE_NOTIFY_PROJECT_DIR: projectDir || "",
  };

  if (customTitle) {
    envVars.CLAUDE_NOTIFY_TITLE = customTitle;
  }

  if (terminal.hwnd) {
    envVars.CLAUDE_NOTIFY_HWND = String(terminal.hwnd);
  }

  writeWindowsTerminalColor(eventName, runtime.log);
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

function writeWindowsTerminalColor(eventName, log) {
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
          CLAUDE_NOTIFY_LOG_FILE: runtime.logFile,
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
