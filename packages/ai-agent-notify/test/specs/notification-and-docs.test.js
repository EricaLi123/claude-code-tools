module.exports = function runNotificationAndDocsTests(h) {
  const {
    assert,
    assertLocalMarkdownLinksExist,
    createNotificationSpec,
    normalizeIncomingNotification,
    read,
    section,
    test,
    TEST_PROJECT_DIR,
  } = h;

  section("Notifications and docs");

  test("notification source normalizer recognizes Claude hook payloads", () => {
    const normalized = normalizeIncomingNotification({
      argv: [],
      stdinData: JSON.stringify({
        hook_event_name: "PermissionRequest",
        session_id: "claude-session-1",
        title: "Claude Needs Permission",
      }),
      env: {},
    });

    assert(normalized.sourceId === "claude-hook");
    assert(normalized.source === "Claude");
    assert(normalized.eventName === "PermissionRequest");
    assert(normalized.sessionId === "claude-session-1");
    assert(normalized.title === "Needs Approval");
    assert(normalized.message === "Waiting for your approval");
    assert(normalized.projectDir === "");
  });

  test("notification spec infers titles and messages for InputRequest", () => {
    const normalized = createNotificationSpec({
      sourceId: "codex-session-watch",
      eventName: "InputRequest",
    });

    assert(normalized.source === "Codex");
    assert(normalized.eventName === "InputRequest");
    assert(normalized.title === "Input Needed");
    assert(normalized.message === "Waiting for your input");
  });

  test("notification source normalizer canonicalizes source-prefixed stop titles", () => {
    const normalized = normalizeIncomingNotification({
      argv: [],
      stdinData: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "claude-session-2",
        title: "Codex Done",
      }),
      env: {},
    });

    assert(normalized.title === "Done");
  });

  test("notification source normalizer recognizes Codex legacy notify argv payloads", () => {
    const normalized = normalizeIncomingNotification({
      argv: [
        "--shell-pid",
        "123",
        JSON.stringify({
          type: "agent-turn-complete",
          "thread-id": "thread-123",
          "turn-id": "turn-123",
          cwd: TEST_PROJECT_DIR,
          client: "codex-tui",
          "input-messages": ["Ping"],
          "last-assistant-message": "Pong",
        }),
      ],
      stdinData: "",
      env: {},
    });

    assert(normalized.sourceId === "codex-legacy-notify");
    assert(normalized.source === "Codex");
    assert(normalized.eventName === "Stop");
    assert(normalized.title === "Done");
    assert(normalized.message === "Task finished");
    assert(normalized.sessionId === "thread-123");
    assert(normalized.turnId === "turn-123");
    assert(normalized.projectDir === TEST_PROJECT_DIR);
  });

  test("notification source normalizer respects explicit source title and message", () => {
    const normalized = normalizeIncomingNotification({
      argv: [],
      stdinData: JSON.stringify({
        source: "BuildBot",
        title: "Queued",
        message: "Waiting in CI",
      }),
      env: {},
    });

    assert(normalized.source === "BuildBot");
    assert(normalized.title === "Queued");
    assert(normalized.message === "Waiting in CI");
  });

  test("README documents codex session watcher usage", () => {
    const readmeContent = read("README.md");
    assert(readmeContent.includes("codex-session-watch"));
    assert(readmeContent.includes("auto-start `codex-session-watch`"));
    assert(readmeContent.includes("approval reminders"));
    assert(readmeContent.includes("If you only care about completion notifications"));
    assert(!readmeContent.includes("If you are not using the MCP sidecar"));
    assert(!readmeContent.includes("codex-watch"));
  });

  test("README documents direct Codex notify support and limitation", () => {
    const readmeContent = read("README.md");
    assert(readmeContent.includes('notify = ["ai-agent-notify.cmd"]'));
    assert(readmeContent.includes("`~/.codex/config.toml`:"));
    assert(readmeContent.includes("covers completion notifications"));
    assert(readmeContent.includes("startup_timeout_sec = 30"));
    assert(
      readmeContent.includes(
        "Use `ai-agent-notify.cmd` for Windows direct process launch entries such as"
      )
    );
    assert(!readmeContent.includes("npx"));
    assert(!readmeContent.includes("April 1, 2026"));
    assert(!readmeContent.includes("AI_AGENT_NOTIFY_PAYLOAD"));
  });

  test("README documents the codex mcp sidecar companion", () => {
    const readmeContent = read("README.md");
    assert(readmeContent.includes("codex-mcp-sidecar"));
    assert(readmeContent.includes("[mcp_servers.ai_agent_notify_sidecar]"));
    assert(readmeContent.includes('command = "ai-agent-notify.cmd"'));
    assert(readmeContent.includes('args = ["codex-mcp-sidecar"]'));
    assert(readmeContent.includes("Do **not** set `cwd`"));
  });

  test("README stays focused on quick setup", () => {
    const readmeContent = read("README.md");
    assert(!readmeContent.includes("## Problem It Solves"));
    assert(readmeContent.includes("## Install"));
    assert(readmeContent.includes("volta install"));
    assert(readmeContent.includes("npm install -g"));
    assert(readmeContent.includes("## Claude Code"));
    assert(readmeContent.includes("## Codex"));
    assert(readmeContent.includes("Stop"));
    assert(readmeContent.includes("PermissionRequest"));
  });

  test("active docs recommend the installed command path over npx", () => {
    const docsIndexContent = read("docs/README.md");
    const approvalContent = read("docs/codex-approval.md");
    assert(docsIndexContent.includes("ai-agent-notify.cmd"));
    assert(!docsIndexContent.includes("`npx.cmd @erica-s/ai-agent-notify`"));
    assert(approvalContent.includes('notify = ["ai-agent-notify.cmd"]'));
    assert(approvalContent.includes("README"));
  });

  test("README stays user-focused while internal docs remain split by topic", () => {
    const readmeContent = read("README.md");
    const developmentContent = read("docs/development.md");
    const architectureContent = read("docs/architecture.md");
    const approvalContent = read("docs/codex-approval.md");
    const windowsRuntimeContent = read("docs/windows-runtime.md");
    const historyContent = read("docs/history/codex-completion-findings.md");
    assert(!readmeContent.includes("Reminder + Localization Responsibilities"));
    assert(!readmeContent.includes("npm link"));
    assert(!readmeContent.includes("node postinstall.js"));
    assert(developmentContent.includes("README"));
    assert(developmentContent.includes("./architecture.md"));
    assert(developmentContent.includes("./codex-approval.md"));
    assert(developmentContent.includes("./windows-runtime.md"));
    assert(developmentContent.includes("./history/"));
    assert(!readmeContent.includes("ai-agent-notify-codex-wrapper.vbs"));
    assert(!developmentContent.includes("AI_AGENT_NOTIFY_PAYLOAD"));
    assert(architectureContent.includes("normalizeIncomingNotification()"));
    assert(architectureContent.includes("codex-session-watch"));
    assert(architectureContent.includes("codex-mcp-sidecar"));
    assert(architectureContent.includes("tui.notification_method"));
    assert(approvalContent.includes("codex-session-watch"));
    assert(approvalContent.includes("codex-mcp-sidecar"));
    assert(approvalContent.includes("default.rules"));
    assert(windowsRuntimeContent.includes("ai-agent-notify.cmd"));
    assert(windowsRuntimeContent.includes("FRAME_BACKGROUND"));
    assert(historyContent.includes("os error 206"));
    assert(historyContent.includes("TUI fallback"));
  });

  test("README and development docs only use valid local markdown links", () => {
    [
      "README.md",
      "docs/development.md",
      "docs/architecture.md",
      "docs/codex-approval.md",
      "docs/windows-runtime.md",
      "docs/history/README.md",
    ].forEach(assertLocalMarkdownLinksExist);
  });
};
