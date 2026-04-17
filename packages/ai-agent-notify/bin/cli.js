#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const { runCodexMcpSidecarMode } = require("../lib/codex-mcp-sidecar-mode");
const { runCodexSessionWatchMode } = require("../lib/codex-session-watch-runner");
const {
  writeCodexCompletionReceiptForNotification,
} = require("../lib/codex-completion-receipts");
const {
  createRuntime,
  detectTerminalContext,
  emitNotification,
} = require("../lib/notify-runtime");
const { normalizeIncomingNotification } = require("../lib/notification-source-parsers");

const PACKAGE_VERSION = readPackageVersion();

if (require.main === module) {
  runCli();
}

async function runCli() {
  const bootstrapRuntime = createRuntime("bootstrap");
  bootstrapRuntime.log(
    `bootstrap start modeHint=${process.argv[2] || "default"} argv=${JSON.stringify(
      process.argv.slice(2)
    )} cwd=${process.cwd()} ppid=${process.ppid}`
  );

  try {
    ensureWindows();
    await main();
  } catch (error) {
    bootstrapRuntime.log(
      `bootstrap fatal modeHint=${process.argv[2] || "default"} error=${
        error && error.message ? error.message : String(error)
      }`
    );
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
  }
}

function ensureWindows() {
  if (process.platform !== "win32") {
    throw new Error("ai-agent-notify currently only supports Windows.");
  }
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === "codex-session-watch" || argv[0] === "--codex-session-watch") {
    const result = await runCodexSessionWatchMode(argv.slice(1));
    if (result && result.handledHelp) {
      printHelp();
    }
    return;
  }

  if (argv[0] === "codex-mcp-sidecar" || argv[0] === "mcp-sidecar") {
    const result = await runCodexMcpSidecarMode({
      argv: argv.slice(1),
      cliPath: path.resolve(__filename),
      packageVersion: PACKAGE_VERSION,
    });
    if (result && result.handledHelp) {
      printHelp();
    }
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
      "  ai-agent-notify",
      "  ai-agent-notify codex-session-watch [--sessions-dir <path>] [--tui-log <path>] [--poll-ms <ms>]",
      "  ai-agent-notify codex-mcp-sidecar",
      "",
      "Modes:",
      "  default             Read notification JSON from stdin or argv and show a notification",
      "  codex-session-watch Watch local Codex rollout files and TUI logs for approval events and completion fallback",
      "  codex-mcp-sidecar   Run a minimal MCP sidecar that records Codex terminal/session hints and ensures codex-session-watch is running",
      "",
      "Flags:",
      "  --shell-pid <pid>     Override the detected shell pid",
      "  --sessions-dir <path> Override the Codex sessions directory (default: %USERPROFILE%\\.codex\\sessions)",
      "  --tui-log <path>      Override the Codex TUI log path (default: %USERPROFILE%\\.codex\\log\\codex-tui.log)",
      "  --poll-ms <ms>        Poll interval for session file scanning (default: 1000)",
      "",
    ].join("\n")
  );
}

async function runDefaultNotifyMode(argv, options = {}) {
  const {
    createRuntimeImpl = createRuntime,
    detectTerminalContextImpl = detectTerminalContext,
    emitNotificationImpl = emitNotification,
    exitProcessImpl = process.exit,
    normalizeIncomingNotificationImpl = normalizeIncomingNotification,
    stdinData = readStdin(),
    writeCodexCompletionReceiptForNotificationImpl = writeCodexCompletionReceiptForNotification,
  } = options;

  const notification = normalizeIncomingNotificationImpl({
    argv,
    stdinData,
    env: process.env,
  });
  const sessionId = notification.sessionId || "unknown";
  const runtime = createRuntimeImpl(sessionId);
  writeCodexCompletionReceiptForNotificationImpl(notification, {
    runtime,
  });

  runtime.log(
    `started mode=notify source=${notification.sourceId} transport=${notification.transport || "none"} session=${sessionId} packageRoot=${runtime.buildInfo.packageRoot}`
  );
  runtime.log(notification.debugSummary);

  if (shouldSkipNotificationDispatch(process.env)) {
    runtime.log("skipping notification dispatch because GITHUB_ACTIONS=true");
    exitProcessImpl(0);
    return null;
  }

  const terminal = detectTerminalContextImpl(argv, runtime.log);

  const child = emitNotificationImpl({
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
    exitProcessImpl(code || 0);
  });

  child.on("error", (error) => {
    runtime.log(`spawn failed: ${error.message}`);
    exitProcessImpl(0);
  });

  return child;
}

function shouldSkipNotificationDispatch(env) {
  return Boolean(env && env.GITHUB_ACTIONS === "true");
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

module.exports.runDefaultNotifyMode = runDefaultNotifyMode;
