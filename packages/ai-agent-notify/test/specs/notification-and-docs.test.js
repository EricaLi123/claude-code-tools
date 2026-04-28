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

    assert(normalized.sourceId === "claude");
    assert(normalized.entryPointId === "notify-mode");
    assert(normalized.source === "claude.notify-mode");
    assert(normalized.eventName === "PermissionRequest");
    assert(normalized.sessionId === "claude-session-1");
    assert(normalized.title === "Needs Approval");
    assert(normalized.message === "Waiting for your approval");
    assert(normalized.projectDir === "");
  });

  test("notification spec infers titles and messages for InputRequest", () => {
    const normalized = createNotificationSpec({
      sourceId: "codex",
      entryPointId: "rollout-watch",
      eventName: "InputRequest",
    });

    assert(normalized.source === "codex.rollout-watch");
    assert(normalized.eventName === "InputRequest");
    assert(normalized.title === "Input Needed");
    assert(normalized.message === "Waiting for your input");
  });

  test("notification spec does not infer source hierarchy from a display string", () => {
    const normalized = createNotificationSpec({
      source: "watch-rollout",
      eventName: "InputRequest",
    });

    assert(normalized.sourceId === "unknown");
    assert(normalized.entryPointId === "");
    assert(normalized.source === "watch-rollout");
  });

  test("notification spec does not rewrite historical source ids", () => {
    const normalized = createNotificationSpec({
      sourceId: "codex-legacy-notify",
      entryPointId: "completion-fallback",
      eventName: "Stop",
    });

    assert(normalized.sourceId === "codex-legacy-notify");
    assert(normalized.entryPointId === "completion-fallback");
    assert(normalized.source === "codex-legacy-notify.completion-fallback");
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

    assert(normalized.sourceId === "codex");
    assert(normalized.entryPointId === "notify-mode");
    assert(normalized.source === "codex.notify-mode");
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
    assert(readmeContent.includes("codex.notify-mode"));
    assert(readmeContent.includes("codex.rollout-watch"));
    assert(readmeContent.includes("codex.tui-watch"));
    assert(readmeContent.includes("claude.notify-mode"));
    assert(readmeContent.includes("approval reminders"));
    assert(readmeContent.includes("input prompts"));
    assert(readmeContent.includes("If you only care about turn-complete notifications"));
    assert(!readmeContent.includes("If you are not using the MCP sidecar"));
    assert(!readmeContent.includes("codex-watch"));
  });

  test("README documents direct Codex notify support and limitation", () => {
    const readmeContent = read("README.md");
    assert(readmeContent.includes('notify = ["ai-agent-notify.cmd"]'));
    assert(readmeContent.includes("`~/.codex/config.toml`:"));
    assert(readmeContent.includes("primary path for Codex turn-complete notifications"));
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

  test("README documents watcher completion fallback without replacing notify-first completion", () => {
    const readmeContent = read("README.md");
    assert(readmeContent.includes("primary path for Codex turn-complete notifications"));
    assert(readmeContent.includes("watcher-side completion fallback"));
    assert(readmeContent.includes("approval reminders"));
    assert(readmeContent.includes("input prompts"));
  });

  test("architecture documents task_complete receipts and delayed fallback", () => {
    const architectureContent = read("docs/architecture.md");
    assert(architectureContent.includes("task_complete"));
    assert(architectureContent.includes("completion receipt"));
    assert(architectureContent.includes("delayed fallback"));
    assert(architectureContent.includes("notify-first"));
    assert(architectureContent.includes("completion 的主路径不走 sidecar"));
    assert(!architectureContent.includes("completion 不走 sidecar。只有 approval 的检测"));
  });

  test("cli help documents codex-session-watch completion fallback wording", () => {
    const cliContent = read("bin/cli.js");
    assert(cliContent.includes("approval events and completion fallback"));
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
    assert(readmeContent.includes("needs approval or input"));
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
    const docsIndexContent = read("docs/README.md");
    const principlesContent = read("docs/principles.md");
    const architectureContent = read("docs/architecture.md");
    const approvalContent = read("docs/codex-approval.md");
    const windowsRuntimeContent = read("docs/windows-runtime.md");
    const historyIndexContent = read("docs/history/README.md");
    const historyContent = read("docs/history/codex-completion-findings.md");
    assert(!readmeContent.includes("Reminder + Localization Responsibilities"));
    assert(!readmeContent.includes("npm link"));
    assert(!readmeContent.includes("node postinstall.js"));
    assert(!readmeContent.includes("ai-agent-notify-codex-wrapper.vbs"));
    assert(docsIndexContent.includes("../README.md"));
    assert(docsIndexContent.includes("./principles.md"));
    assert(docsIndexContent.includes("./architecture.md"));
    assert(docsIndexContent.includes("./codex-approval.md"));
    assert(docsIndexContent.includes("./windows-runtime.md"));
    assert(docsIndexContent.includes("./history/README.md"));
    assert(!docsIndexContent.includes("development.md"));
    assert(principlesContent.includes("../README.md"));
    assert(principlesContent.includes("./architecture.md"));
    assert(principlesContent.includes("./codex-approval.md"));
    assert(principlesContent.includes("./windows-runtime.md"));
    assert(principlesContent.includes("./history/"));
    assert(principlesContent.includes("主要服务开发判断和改动决策"));
    assert(principlesContent.includes("建议阅读顺序"));
    assert(principlesContent.includes("一个事实只保留一个主定义位置"));
    assert(principlesContent.includes("不负责定义当前默认方案"));
    assert(architectureContent.includes("normalizeIncomingNotification()"));
    assert(architectureContent.includes("codex-session-watch"));
    assert(architectureContent.includes("codex-mcp-sidecar"));
    assert(architectureContent.includes("启动期 terminal observation"));
    assert(architectureContent.includes("先尝试 `projectDir` / `cwd` 窗口级回退"));
    assert(architectureContent.includes("tui.notification_method"));
    assert(approvalContent.includes("codex-session-watch"));
    assert(approvalContent.includes("codex-mcp-sidecar"));
    assert(approvalContent.includes("为什么 sidecar 不自己 resolve sessionId？"));
    assert(approvalContent.includes("由 watcher 在扫 rollout / TUI 时统一决定何时把 observation reconcile 成精确 `sessionId` 映射"));
    assert(approvalContent.includes("按 `projectDir` / `cwd` 的祖先后代关系寻找最可能的窗口"));
    assert(approvalContent.includes("这个回退故意只回退 `hwnd`"));
    assert(!approvalContent.includes("没有精确映射就放弃定位增强，只保留通知"));
    assert(approvalContent.includes("default.rules"));
    assert(windowsRuntimeContent.includes("ai-agent-notify.cmd"));
    assert(windowsRuntimeContent.includes("FRAME_BACKGROUND"));
    assert(historyIndexContent.includes("路线边界"));
    assert(historyIndexContent.includes("平台 / 信号 / 实现演进"));
    assert(historyContent.includes("os error 206"));
    assert(historyContent.includes("TUI fallback"));
  });

  test("README and docs only use valid local markdown links", () => {
    [
      "README.md",
      "docs/README.md",
      "docs/principles.md",
      "docs/architecture.md",
      "docs/codex-approval.md",
      "docs/windows-runtime.md",
      "docs/history/README.md",
      "docs/history/codex-completion-findings.md",
      "docs/history/tab-color-history.md",
      "docs/history/legacy-repo-codex-approval-notification-session-2026-03-18.md",
    ].forEach(assertLocalMarkdownLinksExist);
  });
};
