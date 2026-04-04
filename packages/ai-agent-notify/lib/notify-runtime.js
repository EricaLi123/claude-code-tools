const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createNeutralTerminalContext,
  detectTerminalContext,
  findParentInfo,
  writeChildStderr,
} = require("./notify-terminal-context");

const LOG_DIR = path.join(os.tmpdir(), "ai-agent-notify");
const LOG_FILE_PREFIX = "ai-agent-notify";
const IS_DEV = !fs.existsSync(path.join(__dirname, "..", ".published"));

function createRuntime(logId) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const normalizedLogId = String(logId || "unknown").replace(/[^A-Za-z0-9._-]+/g, "-");
  const logFile = path.join(LOG_DIR, `${LOG_FILE_PREFIX}-${normalizedLogId}.log`);

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
    InputRequest: "rgb:ff/99/00",
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
    const watcherPidFile = path.join(LOG_DIR, `watcher-${process.pid}-${Date.now()}.pid`);
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
      runtime.log(`tab-color-watcher spawned pid=${watcherPid} shellPid=${terminal.shellPid}`);
    } else {
      runtime.log(
        `tab-color-watcher launcher exited status=${result.status} without child pid shellPid=${terminal.shellPid}`
      );
    }
  } catch (error) {
    runtime.log(`tab-color-watcher spawn failed: ${error.message}`);
  }
}

module.exports = {
  LOG_DIR,
  LOG_FILE_PREFIX,
  createNeutralTerminalContext,
  createRuntime,
  detectTerminalContext,
  emitNotification,
  findParentInfo,
  writeChildStderr,
};
