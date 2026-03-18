#!/usr/bin/env node

// Lightweight tests for claude-code-notify
// Run: node test/test-cli.js

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "assertion failed");
  }
}

function skip(name, reason) {
  console.log(`  SKIP  ${name}`);
  console.log(`        ${reason}`);
  skipped++;
}

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

let canSpawnChildren = true;
try {
  execFileSync(process.execPath, ["--version"], { stdio: "pipe" });
} catch (error) {
  if (error && error.code === "EPERM") {
    canSpawnChildren = false;
  } else {
    throw error;
  }
}

console.log("\n--- File structure ---");

[
  "bin/cli.js",
  "postinstall.js",
  "scripts/find-hwnd.ps1",
  "scripts/get-shell-pid.ps1",
  "scripts/notify.ps1",
  "scripts/register-protocol.ps1",
  "scripts/start-tab-color-watcher.ps1",
  "scripts/tab-color-watcher.ps1",
].forEach((relPath) => {
  test(`${relPath} exists`, () => {
    assert(fs.existsSync(path.join(ROOT, relPath)), `${relPath} missing`);
  });
});

console.log("\n--- package.json ---");

const pkg = JSON.parse(read("package.json"));

test("postinstall script points to node postinstall.js", () => {
  assert(pkg.scripts && pkg.scripts.postinstall === "node postinstall.js");
});

test("package keeps zero runtime dependencies", () => {
  assert(Object.keys(pkg.dependencies || {}).length === 0, "unexpected runtime dependencies");
});

test("files includes postinstall.js", () => {
  assert(Array.isArray(pkg.files) && pkg.files.includes("postinstall.js"));
});

console.log("\n--- Content checks ---");

const cliContent = read("bin/cli.js");
const notifyContent = read("scripts/notify.ps1");
const postinstallContent = read("postinstall.js");
const watcherContent = read("scripts/tab-color-watcher.ps1");
test("cli.js resolves hwnd, shell pid, and spawns watcher through launcher", () => {
  assert(cliContent.includes("find-hwnd.ps1"));
  assert(cliContent.includes("get-shell-pid.ps1"));
  assert(cliContent.includes("start-tab-color-watcher.ps1"));
  assert(cliContent.includes("--shell-pid"));
  assert(cliContent.includes("launcher exited status="));
  assert(cliContent.includes("WatcherPidFile"));
});

test("cli.js includes codex watcher mode", () => {
  assert(cliContent.includes("codex-watch"));
  assert(cliContent.includes('"app-server"'));
  assert(cliContent.includes("thread/status/changed"));
  assert(cliContent.includes("waitingOnApproval"));
  assert(cliContent.includes("thread/list"));
  assert(cliContent.includes("Codex Needs Approval"));
});

test("cli.js resolves Windows codex shims before spawning", () => {
  assert(cliContent.includes("resolveCodexLaunch"));
  assert(cliContent.includes("where.exe"));
  assert(cliContent.includes('process.env.ComSpec || "cmd.exe"'));
  assert(cliContent.includes('".cmd"'));
});

test("notify.ps1 uses native toast + flash", () => {
  assert(notifyContent.includes("ToastNotificationManager"));
  assert(notifyContent.includes("FlashWindowEx"));
  assert(notifyContent.includes("activationType=`\"protocol`\""));
});

test("postinstall registers protocol", () => {
  assert(postinstallContent.includes("register-protocol.ps1"));
});

test("watcher resets through console attachment plus standard streams", () => {
  assert(watcherContent.includes("Write-OscToInheritedStreams"));
  assert(watcherContent.includes("Write-OscToAttachedConsole"));
  assert(watcherContent.includes("AttachConsole"));
  assert(watcherContent.includes("[Console]::OpenStandardOutput()"));
  assert(watcherContent.includes("[Console]::OpenStandardError()"));
  assert(watcherContent.includes('"$ESC]104;264$ST"'));
  assert(!watcherContent.includes("SendKeys"));
});

test("README documents codex watcher usage", () => {
  const readmeContent = read("README.md");
  assert(readmeContent.includes("codex-watch"));
  assert(readmeContent.includes("waitingOnApproval"));
  assert(readmeContent.includes("thread/status/changed"));
});

console.log("\n--- Smoke ---");

if (!canSpawnChildren) {
  skip("postinstall.js passes node syntax check", "sandbox blocks nested child_process execution");
  if (process.platform === "win32") {
    skip("tab-color-watcher.ps1 parses as a script block", "sandbox blocks nested child_process execution");
    skip("cli.js exits cleanly for Stop", "sandbox blocks nested child_process execution");
    skip("cli.js exits cleanly for PermissionRequest", "sandbox blocks nested child_process execution");
    skip("cli.js exits cleanly for default", "sandbox blocks nested child_process execution");
  }
} else {
  test("postinstall.js passes node syntax check", () => {
    execFileSync("node", ["--check", path.join(ROOT, "postinstall.js")], { stdio: "pipe" });
  });

  if (process.platform === "win32") {
    test("tab-color-watcher.ps1 parses as a script block", () => {
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "[void][scriptblock]::Create((Get-Content '" +
            path.join(ROOT, "scripts", "tab-color-watcher.ps1").replace(/'/g, "''") +
            "' -Raw))",
        ],
        { stdio: "pipe" }
      );
    });

    ["Stop", "PermissionRequest", ""].forEach((eventName) => {
      const label = eventName || "default";
      test(`cli.js exits cleanly for ${label}`, () => {
        const input = eventName
          ? JSON.stringify({ hook_event_name: eventName, session_id: `test-${label}` })
          : "";
        execFileSync("node", [path.join(ROOT, "bin", "cli.js")], {
          input,
          timeout: 15000,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      });
    });
  } else {
    console.log("  SKIP  Windows-only smoke checks");
  }
}

console.log(`\n--- Results: ${passed} passed, ${failed} failed, ${skipped} skipped ---\n`);
process.exit(failed > 0 ? 1 : 0);
