const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const NODE_EXECUTABLE = process.execPath;
const TEST_PROJECT_DIR = "D:\\repo\\sample-project";
const TEST_PACKAGE_DIR = `${TEST_PROJECT_DIR}\\packages\\ai-agent-notify`;

const sessionWatchNotify = require(path.join(ROOT, "lib", "codex-session-watch-notify.js"));
const sessionEventDescriptors = require(path.join(ROOT, "lib", "codex-session-event-descriptors.js"));
const sessionRolloutEvents = require(path.join(ROOT, "lib", "codex-session-rollout-events.js"));
const sessionTuiEvents = require(path.join(ROOT, "lib", "codex-session-tui-events.js"));
const sessionStartHook = require(path.join(ROOT, "lib", "codex-session-start-hook.js"));
const terminalContextStore = require(path.join(ROOT, "lib", "codex-terminal-context-store.js"));
const sessionWatchRunner = require(path.join(ROOT, "lib", "codex-session-watch-runner.js"));
const notifyRuntime = require(path.join(ROOT, "lib", "notify-runtime.js"));
const windowsPaths = require(path.join(ROOT, "lib", "windows-paths.js"));
const { createNotificationSpec } = require(path.join(
  ROOT,
  "lib",
  "notification-source-display.js"
));
const { normalizeIncomingNotification } = require(path.join(
  ROOT,
  "lib",
  "notification-source-parsers.js"
));
const { findCodexSessionStartPayload } = require(path.join(
  ROOT,
  "lib",
  "notification-source-parsers.js"
));

const events = {
  ...sessionEventDescriptors,
  ...sessionRolloutEvents,
  ...sessionTuiEvents,
};

function createHarness() {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

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

  function section(name) {
    console.log(`\n--- ${name} ---`);
  }

  function test(name, fn) {
    try {
      fn();
      console.log(`  PASS  ${name}`);
      passed += 1;
    } catch (error) {
      console.log(`  FAIL  ${name}`);
      console.log(`        ${error.message}`);
      emitGitHubActionsFailureAnnotation(name, error);
      failed += 1;
    }
  }

  function emitGitHubActionsFailureAnnotation(name, error) {
    if (process.env.GITHUB_ACTIONS !== "true") {
      return;
    }

    const message = error && error.message ? error.message : String(error);
    const escapeWorkflowCommand = (value) =>
      String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

    process.stdout.write(
      `::error title=${escapeWorkflowCommand(`ai-agent-notify test failed: ${name}`)}::${escapeWorkflowCommand(message)}\n`
    );
  }

  function assert(condition, message) {
    if (!condition) {
      throw new Error(message || "assertion failed");
    }
  }

  function skip(name, reason) {
    console.log(`  SKIP  ${name}`);
    console.log(`        ${reason}`);
    skipped += 1;
  }

  function read(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
  }

  function assertLocalMarkdownLinksExist(relPath) {
    const absPath = path.join(ROOT, relPath);
    const content = fs.readFileSync(absPath, "utf8");
    const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
    let match;

    while ((match = linkPattern.exec(content)) !== null) {
      const target = match[1].trim();
      if (
        !target ||
        target.startsWith("http://") ||
        target.startsWith("https://") ||
        target.startsWith("mailto:")
      ) {
        continue;
      }

      const withoutFragment = target.split("#")[0];
      if (!withoutFragment) {
        continue;
      }

      const resolved = path.resolve(path.dirname(absPath), withoutFragment);
      assert(fs.existsSync(resolved), `${relPath} broken link: ${target}`);
    }
  }

  function normalizeTestPath(value) {
    return path.resolve(value).replace(/\\/g, "/").toLowerCase();
  }

  function finish() {
    console.log(`\n--- Results: ${passed} passed, ${failed} failed, ${skipped} skipped ---\n`);
    process.exit(failed > 0 ? 1 : 0);
  }

  return {
    ROOT,
    NODE_EXECUTABLE,
    TEST_PACKAGE_DIR,
    TEST_PROJECT_DIR,
    assert,
    assertLocalMarkdownLinksExist,
    canSpawnChildren,
    createNotificationSpec,
    events,
    execFileSync,
    finish,
    fs,
    findCodexSessionStartPayload,
    normalizeIncomingNotification,
    normalizeTestPath,
    notifyRuntime,
    path,
    read,
    section,
    sessionStartHook,
    sessionWatchNotify,
    sessionWatchRunner,
    skip,
    terminalContextStore,
    test,
    windowsPaths,
  };
}

module.exports = createHarness;
