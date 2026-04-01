#!/usr/bin/env node

if (process.platform !== "win32") {
  process.exit(0);
}

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const tasks = [
  {
    kind: "powershell",
    path: path.join(__dirname, "scripts", "register-protocol.ps1"),
    warning: "ai-agent-notify: protocol registration skipped (non-fatal)",
  },
];

for (const task of tasks) {
  try {
    if (task.kind === "powershell") {
      execFileSync(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", task.path],
        { stdio: "inherit" }
      );
      continue;
    }

    execFileSync("node", [task.path], { stdio: "inherit" });
  } catch {
    console.warn(task.warning);
  }
}

try {
  installCodexWrapper();
} catch {
  console.warn("ai-agent-notify: Codex wrapper install skipped (non-fatal)");
}

function installCodexWrapper() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not set");
  }

  const targetDir = path.join(localAppData, "ai-agent-notify");
  const sourcePath = path.join(__dirname, "scripts", "ai-agent-notify-codex-wrapper.vbs");
  const targetPath = path.join(targetDir, "ai-agent-notify-codex-wrapper.vbs");

  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}
