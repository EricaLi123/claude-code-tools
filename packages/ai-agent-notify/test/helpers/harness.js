const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const NODE_EXECUTABLE = process.execPath;
const TEST_PROJECT_DIR = "D:\\repo\\sample-project";
const TEST_PACKAGE_DIR = `${TEST_PROJECT_DIR}\\packages\\ai-agent-notify`;

const cli = require(path.join(ROOT, "bin", "cli.js"));
const sidecarResolver = require(path.join(ROOT, "lib", "codex-sidecar-resolver.js"));
const sidecarState = require(path.join(ROOT, "lib", "codex-sidecar-state.js"));
const notifyRuntime = require(path.join(ROOT, "lib", "notify-runtime.js"));
const windowsPaths = require(path.join(ROOT, "lib", "windows-paths.js"));
const {
  createNotificationSpec,
  normalizeIncomingNotification,
} = require(path.join(ROOT, "lib", "notification-sources.js"));

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
      failed += 1;
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
    cli,
    createNotificationSpec,
    execFileSync,
    finish,
    fs,
    normalizeIncomingNotification,
    normalizeTestPath,
    notifyRuntime,
    path,
    read,
    section,
    sidecarResolver,
    sidecarState,
    skip,
    test,
    windowsPaths,
  };
}

module.exports = createHarness;
