#!/usr/bin/env node

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const os = require("os");
if (process.platform !== "win32") {
  console.error("claude-code-notify currently only supports Windows.");
  process.exit(1);
}

// 环境变量初值
const envVars = {
  PATH: process.env.PATH || "",
  PATHEXT: process.env.PATHEXT || "",
};

// 初始化
let sessionId, eventName, customTitle, isDev, log;

try {
  // Read stdin
  let stdinData = "";
  if (!process.stdin.isTTY) {
    stdinData = fs.readFileSync(0, { encoding: "utf8" });
  }

  let hookJson = null;
  try { hookJson = JSON.parse(stdinData); } catch {}

  sessionId = (hookJson && hookJson.session_id) ? hookJson.session_id : "unknown";
  eventName = (hookJson && hookJson.hook_event_name) || "";
  customTitle = (hookJson && hookJson.title) || "";
  isDev = !fs.existsSync(path.join(__dirname, "..", ".published"));

  const LOG_DIR = path.join(os.tmpdir(), "claude-code-notify");
  fs.mkdirSync(LOG_DIR, { recursive: true });
  envVars.CLAUDE_NOTIFY_LOG_FILE = path.join(LOG_DIR, `session-${sessionId}.log`);

  // 定义 log 函数，写入文件
  log = function(msg) {
    const line = `[${new Date().toISOString()}] [node pid=${process.pid}] ${msg}\n`;
    process.stderr.write(line);
    try { fs.appendFileSync(envVars.CLAUDE_NOTIFY_LOG_FILE, line); } catch {}
  };

  log(`started session=${sessionId}`);
} catch (err) {
  console.error(`init failed: ${err.message}`);
  process.exit(1);
}

// 查找父窗口句柄
function findParentWindowHwnd() {
  const findScript = path.join(__dirname, "..", "scripts", "find-hwnd.ps1");
  const result = spawnSync("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", findScript,
    "-StartPid", String(process.pid),
  ], { encoding: "utf8" });
  if (result.stderr) {
    result.stderr.trim().split(/\r?\n/).filter(Boolean).forEach(l => log(l));
  }
  const hwnd = parseInt((result.stdout || "").trim(), 10);
  return hwnd > 0 ? hwnd : null;
}

const hwnd = findParentWindowHwnd();

// 构建传递给 notify.ps1 的环境变量
try {
  Object.assign(envVars, {
    CLAUDE_NOTIFY_EVENT: eventName,
    CLAUDE_NOTIFY_IS_DEV: isDev ? "1" : "0",
    CLAUDE_NOTIFY_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR || "",
    ...(customTitle ? { CLAUDE_NOTIFY_TITLE: customTitle } : {}),
    ...(hwnd ? { CLAUDE_NOTIFY_HWND: String(hwnd) } : {}),
  });
} catch (err) {
  log(`buildEnvVars failed: ${err.message}`);
}

// 启动 notify.ps1
const scriptPath = path.join(__dirname, "..", "scripts", "notify.ps1");
const ps = spawn(
  "powershell",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
  { stdio: ["ignore", "inherit", "inherit"], env: envVars }
);

ps.on("close", (code) => {
  log(`notify.ps1 exited code=${code}`);
  process.exit(code || 0);
});

ps.on("error", (err) => {
  log(`spawn failed: ${err.message}`);
  process.exit(0);
});
