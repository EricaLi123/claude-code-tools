module.exports = function runSmokeTests(h) {
  const {
    assert,
    canSpawnChildren,
    execFileSync,
    NODE_EXECUTABLE,
    path,
    ROOT,
    section,
    skip,
    test,
    TEST_PROJECT_DIR,
  } = h;

  section("Smoke");

  if (!canSpawnChildren) {
    if (process.platform === "win32") {
      skip(
        "tab-color-watcher.ps1 parses as a script block",
        "sandbox blocks nested child_process execution"
      );
      skip("cli.js exits cleanly for Stop", "sandbox blocks nested child_process execution");
      skip(
        "cli.js exits cleanly for PermissionRequest",
        "sandbox blocks nested child_process execution"
      );
      skip("cli.js exits cleanly for default", "sandbox blocks nested child_process execution");
    }
    return;
  }

  if (process.platform !== "win32") {
    console.log("  SKIP  Windows-only smoke checks");
    return;
  }

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
      execFileSync(NODE_EXECUTABLE, [path.join(ROOT, "bin", "cli.js")], {
        input,
        timeout: 15000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    });
  });

  test("cli.js exits cleanly for Codex legacy notify argv payload", () => {
    execFileSync(
      NODE_EXECUTABLE,
      [
        path.join(ROOT, "bin", "cli.js"),
        JSON.stringify({
          type: "agent-turn-complete",
          "thread-id": "thread-smoke-1",
          "turn-id": "turn-smoke-1",
          cwd: TEST_PROJECT_DIR,
          client: "codex-tui",
          "input-messages": ["Ping"],
          "last-assistant-message": "Pong",
        }),
      ],
      {
        timeout: 15000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
  });

  test("cli.js prints help for codex-session-watch", () => {
    const output = execFileSync(
      NODE_EXECUTABLE,
      [path.join(ROOT, "bin", "cli.js"), "codex-session-watch", "--help"],
      {
        timeout: 15000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    assert(output.includes("codex-session-watch"));
    assert(output.includes("--sessions-dir"));
    assert(output.includes("--tui-log"));
  });
};
