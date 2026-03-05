#!/usr/bin/env node

const { spawn } = require("child_process");
const path = require("path");

const command = process.argv[2];

if (command === "setup") {
  // Run setup
  const setupScript = path.join(__dirname, "..", "setup.js");
  require(setupScript);
} else {
  // Default: run notification (called by Claude Code hook via stdin)
  if (process.platform !== "win32") {
    // macOS/Linux: not yet supported
    console.error("claude-code-notify currently only supports Windows.");
    process.exit(1);
  }

  const scriptPath = path.join(__dirname, "..", "scripts", "notify.ps1");
  const ps = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { stdio: ["pipe", "inherit", "inherit"] }
  );

  // Pipe stdin from Claude Code hook to PowerShell
  process.stdin.pipe(ps.stdin);

  ps.on("close", (code) => {
    process.exit(code || 0);
  });

  ps.on("error", (err) => {
    // Silently fail — notifications are non-critical
    process.exit(0);
  });
}
