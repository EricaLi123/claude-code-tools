const crypto = require("crypto");
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
const PACKAGE_ROOT = path.join(__dirname, "..");
const PACKAGE_JSON_PATH = path.join(PACKAGE_ROOT, "package.json");
const PUBLISHED_MARKER_PATH = path.join(PACKAGE_ROOT, ".published");
const BUILD_FINGERPRINT_ROOTS = ["package.json", "bin", "lib", "scripts"];
const BUILD_FINGERPRINT_EXTENSIONS = new Set([".js", ".json", ".ps1", ".vbs"]);
const BUILD_INFO = Object.freeze(readBuildInfo());
const IS_DEV = BUILD_INFO.installKind !== "published";

function createRuntime(logId, { nowProvider } = {}) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const normalizedLogId = normalizeLogId(logId);
  const getNow = typeof nowProvider === "function" ? nowProvider : () => new Date();

  function log(message) {
    const now = getNow();
    const logFile = getRuntimeLogFilePath(normalizedLogId, { now });
    const line =
      `[${now.toISOString()}] ` +
      `[node pid=${process.pid} ${BUILD_INFO.logTag}] ` +
      `${message}\n`;
    process.stderr.write(line);
    try {
      ensureLogFileDirectory(logFile);
      fs.appendFileSync(logFile, line);
    } catch {}
  }

  return {
    buildInfo: BUILD_INFO,
    isDev: IS_DEV,
    logStem: buildRuntimeLogStem(normalizedLogId),
    get logFile() {
      return getRuntimeLogFilePath(normalizedLogId, { now: getNow() });
    },
    log,
  };
}

function normalizeLogId(logId) {
  return String(logId || "unknown").replace(/[^A-Za-z0-9._-]+/g, "-");
}

function formatLogDay(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getRuntimeLogFilePath(logId, { now = new Date() } = {}) {
  const normalizedLogId = normalizeLogId(logId);
  return path.join(LOG_DIR, `${buildRuntimeLogStem(normalizedLogId)}-${formatLogDay(now)}.log`);
}

function buildRuntimeLogStem(logId) {
  const normalizedLogId = normalizeLogId(logId);
  return `${LOG_FILE_PREFIX}-${normalizedLogId}`;
}

function ensureLogFileDirectory(logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
}

function readBuildInfo() {
  const packageJson = readPackageJson();
  const version = packageJson.version || "0.0.0";
  const packageName = packageJson.name || "ai-agent-notify";
  const installKind = fs.existsSync(PUBLISHED_MARKER_PATH) ? "published" : "workspace";
  const gitCommit = readGitCommit();
  const gitDirty = readGitDirtyState();
  const sourceFingerprint = computeSourceFingerprint();

  return {
    packageName,
    packageRoot: PACKAGE_ROOT,
    version,
    installKind,
    gitCommit,
    gitDirty,
    sourceFingerprint,
    logTag:
      `ver=${version} ` +
      `git=${gitCommit} ` +
      `dirty=${gitDirty} ` +
      `src=${sourceFingerprint} ` +
      `install=${installKind}`,
  };
}

function readPackageJson() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
  } catch {
    return {};
  }
}

function readGitCommit() {
  const result = runGitCommand(["rev-parse", "--short=12", "HEAD"]);
  if (!result.ok) {
    return "unknown";
  }

  const commit = result.stdout.trim();
  return commit || "unknown";
}

function readGitDirtyState() {
  const result = runGitCommand([
    "status",
    "--short",
    "--untracked-files=all",
    "--",
    "package.json",
    "bin",
    "lib",
    "scripts",
  ]);
  if (!result.ok) {
    return "unknown";
  }
  return result.stdout.trim() ? "1" : "0";
}

function runGitCommand(args) {
  try {
    const result = spawnSync("git", args, {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });

    return {
      ok: result.status === 0 && !result.error,
      stdout: result.stdout || "",
    };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function computeSourceFingerprint() {
  const hash = crypto.createHash("sha1");
  const files = listFingerprintFiles();

  files.forEach((filePath) => {
    const relativePath = path.relative(PACKAGE_ROOT, filePath).replace(/\\/g, "/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  });

  return hash.digest("hex").slice(0, 12);
}

function listFingerprintFiles() {
  const files = [];

  BUILD_FINGERPRINT_ROOTS.forEach((relativePath) => {
    const absolutePath = path.join(PACKAGE_ROOT, relativePath);
    collectFingerprintFiles(absolutePath, files);
  });

  return files.sort((left, right) => left.localeCompare(right));
}

function collectFingerprintFiles(targetPath, files) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    fs.readdirSync(targetPath)
      .sort((left, right) => left.localeCompare(right))
      .forEach((entry) => collectFingerprintFiles(path.join(targetPath, entry), files));
    return;
  }

  if (BUILD_FINGERPRINT_EXTENSIONS.has(path.extname(targetPath).toLowerCase())) {
    files.push(targetPath);
  }
}

function emitNotification({
  source,
  entryPointId,
  eventName,
  title,
  message,
  rawEventType,
  runtime,
  terminal,
}) {
  const envVars = {
    PATH: process.env.PATH || "",
    PATHEXT: process.env.PATHEXT || "",
    TOAST_NOTIFY_EVENT: eventName,
    TOAST_NOTIFY_IS_DEV: runtime.isDev ? "1" : "0",
    TOAST_NOTIFY_LOG_FILE: runtime.logFile,
    TOAST_NOTIFY_LOG_ROOT: LOG_DIR,
    TOAST_NOTIFY_LOG_STEM: runtime.logStem,
  };

  if (source) {
    envVars.TOAST_NOTIFY_SOURCE = source;
  }

  if (entryPointId) {
    envVars.TOAST_NOTIFY_ENTRY_POINT = entryPointId;
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
          TOAST_NOTIFY_LOG_ROOT: LOG_DIR,
          TOAST_NOTIFY_LOG_STEM: runtime.logStem,
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
  BUILD_INFO,
  LOG_DIR,
  LOG_FILE_PREFIX,
  createNeutralTerminalContext,
  createRuntime,
  detectTerminalContext,
  emitNotification,
  formatLogDay,
  findParentInfo,
  buildRuntimeLogStem,
  getRuntimeLogFilePath,
  writeChildStderr,
};
