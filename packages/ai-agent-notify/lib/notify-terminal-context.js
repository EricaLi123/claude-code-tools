const { spawnSync } = require("child_process");
const path = require("path");

const { getArgValue, getEnvFirst } = require("./shared-utils");

function createNeutralTerminalContext() {
  return {
    hwnd: null,
    shellPid: null,
    isWindowsTerminal: false,
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

function getExplicitShellPid(argv) {
  const raw = getArgValue(argv, "--shell-pid") || getEnvFirst(["TOAST_NOTIFY_SHELL_PID"]) || "";
  const pid = parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
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
    { encoding: "utf8", windowsHide: true }
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
    { encoding: "utf8", windowsHide: true }
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

module.exports = {
  createNeutralTerminalContext,
  detectTerminalContext,
  findParentInfo,
  writeChildStderr,
};
