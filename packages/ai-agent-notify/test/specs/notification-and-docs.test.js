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

  test("notification agent normalizer recognizes Claude hook payloads", () => {
    const normalized = normalizeIncomingNotification({
      argv: [],
      stdinData: JSON.stringify({
        hook_event_name: "PermissionRequest",
        session_id: "claude-session-1",
        title: "Claude Needs Permission",
      }),
      env: {},
    });

    assert(normalized.agentId === "claude");
    assert(normalized.entryPointId === "notify-mode");
    assert(!("source" in normalized));
    assert(normalized.eventName === "PermissionRequest");
    assert(normalized.sessionId === "claude-session-1");
    assert(normalized.title === "Needs Approval");
    assert(normalized.message === "Waiting for your approval");
    assert(normalized.projectDir === "");
  });

  test("notification spec infers titles and messages for InputRequest", () => {
    const normalized = createNotificationSpec({
      agentId: "codex",
      entryPointId: "rollout-watch",
      eventName: "InputRequest",
    });

    assert(normalized.agentId === "codex");
    assert(!("source" in normalized));
    assert(normalized.eventName === "InputRequest");
    assert(normalized.title === "Input Needed");
    assert(normalized.message === "Waiting for your input");
  });

  test("notification spec does not infer agent hierarchy from a display string", () => {
    const normalized = createNotificationSpec({
      source: "watch-rollout",
      eventName: "InputRequest",
    });

    assert(normalized.agentId === "unknown");
    assert(normalized.entryPointId === "");
    assert(!("source" in normalized));
  });

  test("notification spec canonicalizes codex-specific agent ids down to the agent source", () => {
    const normalized = createNotificationSpec({
      agentId: "codex-legacy-notify",
      entryPointId: "hooks-mode",
      eventName: "Stop",
    });

    assert(normalized.agentId === "codex");
    assert(normalized.entryPointId === "hooks-mode");
    assert(!("source" in normalized));
  });

  test("notification agent normalizer canonicalizes agent-prefixed stop titles", () => {
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

  test("notification agent normalizer recognizes Codex legacy notify argv payloads", () => {
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

    assert(normalized.agentId === "codex");
    assert(normalized.entryPointId === "notify-mode");
    assert(!("source" in normalized));
    assert(normalized.eventName === "Stop");
    assert(normalized.title === "Done");
    assert(normalized.message === "Task finished");
    assert(normalized.sessionId === "thread-123");
    assert(normalized.turnId === "turn-123");
    assert(normalized.projectDir === TEST_PROJECT_DIR);
  });

  test("notification agent normalizer recognizes Codex hook PermissionRequest payloads", () => {
    const normalized = normalizeIncomingNotification({
      argv: [],
      stdinData: JSON.stringify({
        hook_event_name: "PermissionRequest",
        session_id: "codex-hooks-session-1",
        turn_id: "codex-hooks-turn-1",
        cwd: TEST_PROJECT_DIR,
        transcript_path: "C:\\Users\\ericali\\.codex\\history\\session.jsonl",
        model: "gpt-5.5",
        tool_name: "Bash",
        tool_input: {
          command: "git status",
        },
      }),
      env: {},
    });

    assert(normalized.agentId === "codex");
    assert(normalized.entryPointId === "hooks-mode");
    assert(!("source" in normalized));
    assert(normalized.eventName === "PermissionRequest");
    assert(normalized.sessionId === "codex-hooks-session-1");
    assert(normalized.turnId === "codex-hooks-turn-1");
    assert(normalized.projectDir === TEST_PROJECT_DIR);
    assert(normalized.title === "Needs Approval");
    assert(normalized.message === "Waiting for your approval");
    assert(normalized.rawEventType === "PermissionRequest");
  });

  test("notification agent normalizer recognizes Codex hook Stop payloads", () => {
    const normalized = normalizeIncomingNotification({
      argv: [],
      stdinData: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "codex-hooks-session-2",
        turn_id: "codex-hooks-turn-2",
        cwd: TEST_PROJECT_DIR,
        transcript_path: "C:\\Users\\ericali\\.codex\\history\\session.jsonl",
        model: "gpt-5.5",
        stop_hook_active: false,
        last_assistant_message: "Done",
      }),
      env: {},
    });

    assert(normalized.agentId === "codex");
    assert(normalized.entryPointId === "hooks-mode");
    assert(!("source" in normalized));
    assert(normalized.eventName === "Stop");
    assert(normalized.sessionId === "codex-hooks-session-2");
    assert(normalized.turnId === "codex-hooks-turn-2");
    assert(normalized.projectDir === TEST_PROJECT_DIR);
    assert(normalized.title === "Done");
    assert(normalized.message === "Task finished");
    assert(normalized.rawEventType === "Stop");
  });

  test("notification agent normalizer ignores explicit source while respecting title and message", () => {
    const normalized = normalizeIncomingNotification({
      argv: [],
      stdinData: JSON.stringify({
        source: "BuildBot",
        title: "Queued",
        message: "Waiting in CI",
      }),
      env: {},
    });

    assert(normalized.agentId === "unknown");
    assert(!("source" in normalized));
    assert(normalized.title === "Queued");
    assert(normalized.message === "Waiting in CI");
  });

  test("README documents codex session watcher as input-only support", () => {
    const readmeContent = read("README.md");
    assert(readmeContent.includes("codex-session-watch"));
    assert(readmeContent.includes("auto-start `codex-session-watch`"));
    assert(readmeContent.includes("`notify-mode`"));
    assert(readmeContent.includes("`rollout-watch`"));
    assert(readmeContent.includes("`tui-watch`"));
    assert(readmeContent.includes("`claude`"));
    assert(readmeContent.includes("input prompts"));
    assert(readmeContent.includes("watcher 只处理 `InputRequest`"));
    assert(!readmeContent.includes("approval reminders"));
    assert(!readmeContent.includes("completion fallback"));
    assert(!readmeContent.includes("parallel validation"));
    assert(!readmeContent.includes("codex-watch"));
  });

  test("README documents direct Codex notify support and limitation", () => {
    const readmeContent = read("README.md");
    assert(readmeContent.includes("codex_hooks = true"));
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

  test("README documents hooks for PermissionRequest and Stop while watcher stays on InputRequest", () => {
    const readmeContent = read("README.md");
    assert(readmeContent.includes("PermissionRequest"));
    assert(readmeContent.includes("Stop"));
    assert(readmeContent.includes("InputRequest"));
    assert(readmeContent.includes("hooks.json"));
    assert(readmeContent.includes('"timeout": 2'));
    assert(readmeContent.includes("watcher 只处理 `InputRequest`"));
    assert(readmeContent.includes("Codex 当前会跳过带 `async: true` 的 hooks"));
    assert(readmeContent.includes("`timeout`，当前建议值是 `2` 秒"));
    assert(!readmeContent.includes("后台 worker"));
    assert(!readmeContent.includes("watcher-side completion fallback"));
    assert(!readmeContent.includes("InputRequest still stays on `codex-session-watch`"));
  });

  test("architecture documents hooks ownership and dual-source InputRequest watcher", () => {
    const architectureContent = read("docs/architecture.md");
    assert(architectureContent.includes("hooks-mode"));
    assert(architectureContent.includes("PermissionRequest"));
    assert(architectureContent.includes("Stop"));
    assert(architectureContent.includes("InputRequest"));
    assert(architectureContent.includes("rollout JSONL"));
    assert(architectureContent.includes("codex-tui.log"));
    assert(architectureContent.includes("watcher 只处理 `InputRequest`"));
    assert(architectureContent.includes("`hooks.json` 的 `timeout`"));
    assert(!architectureContent.includes("detached worker"));
    assert(!architectureContent.includes("task_complete"));
    assert(!architectureContent.includes("completion receipt"));
    assert(!architectureContent.includes("delayed fallback"));
    assert(!architectureContent.includes("并行对账"));
  });

  test("docs define agentId and entryPointId as the canonical normalized contract", () => {
    const readmeContent = read("README.md");
    const architectureContent = read("docs/architecture.md");
    const windowsRuntimeContent = read("docs/windows-runtime.md");

    assert(readmeContent.includes("`agentId` 只表示 agent 来源"));
    assert(readmeContent.includes("`entryPointId`"));
    assert(architectureContent.includes("## 归一化字段契约"));
    assert(architectureContent.includes("`agentId` 只表示 agent 来源"));
    assert(architectureContent.includes("`source` 已从规范字段删除"));
    assert(windowsRuntimeContent.includes("### 归一化字段约定"));
    assert(windowsRuntimeContent.includes("`agentId` 只表示 agent 来源"));
    assert(windowsRuntimeContent.includes("`TOAST_NOTIFY_AGENT_ID` | agent 来源 id"));
    assert(windowsRuntimeContent.includes("`TOAST_NOTIFY_ENTRY_POINT`"));
  });

  test("cli help documents codex-session-watch input prompt wording", () => {
    const cliContent = read("bin/cli.js");
    assert(cliContent.includes("input prompts"));
    assert(!cliContent.includes("approval events and completion fallback"));
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
    assert(approvalContent.includes("codex_hooks = true"));
    assert(approvalContent.includes('"hooks": {'));
    assert(approvalContent.includes('"timeout": 2'));
    assert(approvalContent.includes("PermissionRequest"));
    assert(approvalContent.includes("Stop"));
    assert(approvalContent.includes("InputRequest"));
    assert(approvalContent.includes("Codex 当前会跳过带 `async: true` 的 hooks"));
    assert(approvalContent.includes("当前方案不再拆父子程序"));
    assert(!approvalContent.includes("detached worker"));
    assert(!approvalContent.includes("parallel"));
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
    assert(architectureContent.includes("rollout JSONL"));
    assert(architectureContent.includes("codex-tui.log"));
    assert(approvalContent.includes("codex-session-watch"));
    assert(approvalContent.includes("codex-mcp-sidecar"));
    assert(approvalContent.includes("hooks.json"));
    assert(approvalContent.includes("watcher 只处理 `InputRequest`"));
    assert(windowsRuntimeContent.includes("ai-agent-notify.cmd"));
    assert(windowsRuntimeContent.includes("FRAME_BACKGROUND"));
    assert(historyIndexContent.includes("路线边界"));
    assert(historyIndexContent.includes("平台 / 信号 / 实现演进"));
    assert(historyContent.includes("os error 206"));
    assert(historyContent.includes("TUI fallback"));
  });

  test("README and docs only use valid local markdown links", () => {
    [
      "AGENTS.md",
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
