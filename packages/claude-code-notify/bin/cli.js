#!/usr/bin/env node

const { spawn } = require("child_process");
const path = require("path");

if (process.platform !== "win32") {
  console.error("claude-code-notify currently only supports Windows.");
  process.exit(1);
}

const scriptPath = path.join(__dirname, "..", "scripts", "notify.ps1");
const ps = spawn(
  "powershell",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
  { stdio: ["pipe", "inherit", "inherit"] }
);

if (process.stdin.isTTY) {
  ps.stdin.end();
} else {
  process.stdin.pipe(ps.stdin);
}

ps.on("close", (code) => {
  process.exit(code || 0);
});

ps.on("error", (err) => {
  console.error("claude-code-notify: spawn failed:", err.message);
  process.exit(0);
});
