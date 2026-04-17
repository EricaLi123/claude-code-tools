module.exports = function runApprovalSuppressionTests(h) {
  const { approval, assert, normalizeTestPath, path, ROOT, section, test } = h;

  section("Approval suppression");

  test("approved PowerShell command rules suppress exact require_escalated shell commands", () => {
    const rules = approval.parseApprovedCommandRules(
      'prefix_rule(pattern=["C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe", "-Command", "rg -n \\"model|openrouter|provider|apiKey|baseUrl|llm\\" \\"D:\\\\XAGIT\\\\kids-tools\\\\apps\\\\ai-ui-case-runner\\""], decision="allow")'
    );

    assert(rules.length === 1, "expected one parsed approved rule");
    assert(
      approval.getCodexRequireEscalatedSuppressionReason({
        event: {
          eventType: "require_escalated_tool_call",
          toolArgs: {
            command:
              'rg -n "model|openrouter|provider|apiKey|baseUrl|llm" "D:\\XAGIT\\kids-tools\\apps\\ai-ui-case-runner"',
          },
        },
        approvalPolicy: "",
        sandboxPolicy: null,
        approvedCommandRules: rules,
      }) === "approved_rule"
    );
  });

  test("approved PowerShell command rules suppress prefix_rule-based require_escalated shell commands", () => {
    const rules = approval.parseApprovedCommandRules(
      'prefix_rule(pattern=["C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe", "-Command", "Get-ChildItem -Recurse -File \\"D:\\\\XAGIT\\\\kids-tools\\\\apps\\\\ai-ui-case-runner\\" | Select-Object -ExpandProperty FullName"], decision="allow")'
    );

    assert(rules.length === 1, "expected one parsed approved rule");
    assert(
      approval.getCodexRequireEscalatedSuppressionReason({
        event: {
          eventType: "require_escalated_tool_call",
          toolArgs: {
            command:
              'Get-ChildItem -Recurse -File "D:\\XAGIT\\kids-tools\\apps\\ai-ui-case-runner" | Select-Object -ExpandProperty FullName',
            prefix_rule: [
              "Get-ChildItem",
              "-Recurse",
              "-File",
              "D:\\XAGIT\\kids-tools\\apps\\ai-ui-case-runner",
            ],
          },
        },
        approvalPolicy: "",
        sandboxPolicy: null,
        approvedCommandRules: rules,
      }) === "approved_rule"
    );
  });

  test("approved command rules do not suppress write require_escalated shell commands", () => {
    const rules = approval.parseApprovedCommandRules(
      'prefix_rule(pattern=["C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe", "-Command", "git add -- README.md test/test-cli.js; git commit -m \\"Trim README to user-facing setup\\""], decision="allow")'
    );

    assert(rules.length === 1, "expected one parsed approved rule");
    assert(
      approval.getCodexRequireEscalatedSuppressionReason({
        event: {
          eventType: "require_escalated_tool_call",
          toolArgs: {
            command:
              'git add -- README.md test/test-cli.js; git commit -m "Trim README to user-facing setup"',
            prefix_rule: ["git", "commit"],
          },
        },
        approvalPolicy: "",
        sandboxPolicy: null,
        approvedCommandRules: rules,
      }) === ""
    );
  });

  test("extractCommandApprovalRoots normalizes absolute file and directory roots", () => {
    const packageRoot = normalizeTestPath(ROOT);
    const binDir = normalizeTestPath(path.join(ROOT, "bin"));
    const fileRoots = approval.extractCommandApprovalRoots({
      command: `Get-Content -Path '${path.join(ROOT, "bin", "cli.js")}'`,
      workdir: ROOT,
    });
    const dirRoots = approval.extractCommandApprovalRoots({
      command: `Get-ChildItem '${path.join(ROOT, "bin")}' -File | Select-Object -ExpandProperty FullName`,
      workdir: ROOT,
    });
    assert(fileRoots.includes(packageRoot));
    assert(dirRoots.includes(packageRoot));
    assert(fileRoots.includes(packageRoot) && !fileRoots.includes(binDir));
  });

  test("extractCommandApprovalRoots ignores PowerShell here-string tokens around inline node scripts", () => {
    const githubRunnerRoot = "D:\\a\\ai-tools\\ai-tools\\packages\\ai-agent-notify";
    const packageRoot = normalizeTestPath(githubRunnerRoot);
    const inlineNodeRoots = approval.extractCommandApprovalRoots({
      command:
        `@'\nconst root = '${githubRunnerRoot.replace(/\\/g, "/")}';\n` +
        `writeAsciiJs(path.join(root, 'bin/cli.js'), 'x');\n'@ | node -`,
      workdir: githubRunnerRoot,
    });

    assert(inlineNodeRoots.includes(packageRoot));
    assert(
      inlineNodeRoots.length === 1,
      `inline node roots should only resolve the package root: ${JSON.stringify(inlineNodeRoots)}`
    );
    assert(!inlineNodeRoots.some((root) => root.includes("@\nconst root")));
  });

  test("confirmed session approval suppresses later read-only require_escalated commands in the same root", () => {
    const recentRequireEscalatedEvents = new Map();
    const sessionApprovalGrants = new Map();
    const nowMs = 1_000_000;
    const packageRoot = ROOT;

    approval.rememberRecentRequireEscalatedEvent(
      recentRequireEscalatedEvents,
      {
        dedupeKey: "session-a|exec|turn-a|Get-Content",
        eventType: "require_escalated_tool_call",
        projectDir: packageRoot,
        sessionId: "session-a",
        toolArgs: {
          command: `Get-Content -Path '${path.join(packageRoot, "bin", "cli.js")}'`,
          workdir: packageRoot,
        },
        turnId: "turn-a",
      },
      nowMs - 1_000
    );

    const added = approval.confirmSessionApprovalForRecentEvents({
      recentRequireEscalatedEvents,
      runtime: { log: () => {} },
      sessionApprovalGrants,
      sessionId: "session-a",
      source: "approved_rule_saved",
      turnId: "turn-a",
      nowMs,
    });

    assert(added === 1, "expected one confirmed root");
    assert(
      approval.getSessionRequireEscalatedSuppressionReason({
        event: {
          eventType: "require_escalated_tool_call",
          sessionId: "session-a",
          toolArgs: {
            command:
              `Get-ChildItem '${path.join(packageRoot, "lib")}' -File | Select-Object -ExpandProperty FullName`,
            workdir: packageRoot,
          },
        },
        nowMs: nowMs + 500,
        sessionApprovalGrants,
      }) === "session_recent_read_grant"
    );
  });

  test("read-only require_escalated commands use a longer pending grace window", () => {
    const readOnlyGraceMs = approval.getCodexApprovalNotifyGraceMs({
      eventType: "require_escalated_tool_call",
      toolArgs: {
        command: `Get-Content -Path '${path.join(ROOT, "bin", "cli.js")}'`,
        workdir: ROOT,
      },
    });
    const writeGraceMs = approval.getCodexApprovalNotifyGraceMs({
      eventType: "require_escalated_tool_call",
      toolArgs: {
        command: `node "${path.join(ROOT, "bin", "cli.js")}" --help`,
        workdir: ROOT,
      },
    });

    assert(readOnlyGraceMs > writeGraceMs);
  });

  test("pending approval batching collapses sibling require_escalated calls from the same turn", () => {
    const pendingApprovalNotifications = new Map();
    const pendingApprovalCallIds = new Map();

    pendingApprovalNotifications.set("approval-a", {
      dedupeKey: "approval-a",
      eventType: "require_escalated_tool_call",
      sessionId: "session-batch",
      turnId: "turn-batch",
      callId: "call-a",
      pendingSinceMs: 1_000,
      deadlineMs: 2_000,
    });
    pendingApprovalNotifications.set("approval-b", {
      dedupeKey: "approval-b",
      eventType: "require_escalated_tool_call",
      sessionId: "session-batch",
      turnId: "turn-batch",
      callId: "call-b",
      pendingSinceMs: 1_120,
      deadlineMs: 6_120,
    });
    pendingApprovalNotifications.set("approval-other", {
      dedupeKey: "approval-other",
      eventType: "require_escalated_tool_call",
      sessionId: "session-batch",
      turnId: "turn-other",
      callId: "call-other",
      pendingSinceMs: 1_080,
      deadlineMs: 2_080,
    });
    pendingApprovalCallIds.set("call-a", "approval-a");
    pendingApprovalCallIds.set("call-b", "approval-b");
    pendingApprovalCallIds.set("call-other", "approval-other");

    const batch = approval.drainPendingApprovalBatch({
      pendingApprovalNotifications,
      pendingApprovalCallIds,
      representativeKey: "approval-a",
    });

    assert(batch.batchKey === "session-batch|turn-batch|require_escalated_tool_call");
    assert(batch.count === 2);
    assert(batch.representative && batch.representative.dedupeKey === "approval-a");
    assert(!pendingApprovalNotifications.has("approval-a"));
    assert(!pendingApprovalNotifications.has("approval-b"));
    assert(pendingApprovalNotifications.has("approval-other"));
    assert(!pendingApprovalCallIds.has("call-a"));
    assert(!pendingApprovalCallIds.has("call-b"));
    assert(pendingApprovalCallIds.get("call-other") === "approval-other");
  });

  test("pending approval batching keeps later same-turn require_escalated calls separate", () => {
    const pendingApprovalNotifications = new Map();
    const pendingApprovalCallIds = new Map();

    pendingApprovalNotifications.set("approval-a", {
      dedupeKey: "approval-a",
      eventType: "require_escalated_tool_call",
      sessionId: "session-batch",
      turnId: "turn-batch",
      callId: "call-a",
      pendingSinceMs: 1_000,
      deadlineMs: 2_000,
    });
    pendingApprovalNotifications.set("approval-late", {
      dedupeKey: "approval-late",
      eventType: "require_escalated_tool_call",
      sessionId: "session-batch",
      turnId: "turn-batch",
      callId: "call-late",
      pendingSinceMs: 1_800,
      deadlineMs: 2_800,
    });
    pendingApprovalCallIds.set("call-a", "approval-a");
    pendingApprovalCallIds.set("call-late", "approval-late");

    const batch = approval.drainPendingApprovalBatch({
      pendingApprovalNotifications,
      pendingApprovalCallIds,
      representativeKey: "approval-a",
    });

    assert(batch.batchKey === "session-batch|turn-batch|require_escalated_tool_call");
    assert(batch.count === 1);
    assert(!pendingApprovalNotifications.has("approval-a"));
    assert(pendingApprovalNotifications.has("approval-late"));
    assert(!pendingApprovalCallIds.has("call-a"));
    assert(pendingApprovalCallIds.get("call-late") === "approval-late");
  });

  test("confirmation suppressions cancel pending read-only approvals before they emit", () => {
    const recentRequireEscalatedEvents = new Map();
    const sessionApprovalGrants = new Map();
    const pendingApprovalNotifications = new Map();
    const pendingApprovalCallIds = new Map();
    const nowMs = 3_000_000;
    const packageRoot = ROOT;

    approval.rememberRecentRequireEscalatedEvent(
      recentRequireEscalatedEvents,
      {
        dedupeKey: "session-c|exec|turn-c|Get-Content",
        eventType: "require_escalated_tool_call",
        projectDir: packageRoot,
        sessionId: "session-c",
        toolArgs: {
          command: `Get-Content -Path '${path.join(packageRoot, "README.md")}'`,
          workdir: packageRoot,
        },
        turnId: "turn-c",
      },
      nowMs - 1_000
    );

    pendingApprovalNotifications.set("pending-read", {
      dedupeKey: "pending-read",
      eventType: "require_escalated_tool_call",
      sessionId: "session-c",
      toolArgs: {
        command:
          `Get-ChildItem '${path.join(packageRoot, "lib")}' -File | Select-Object -ExpandProperty FullName`,
        workdir: packageRoot,
      },
      turnId: "turn-c",
    });
    pendingApprovalNotifications.set("pending-write", {
      dedupeKey: "pending-write",
      eventType: "require_escalated_tool_call",
      sessionId: "session-c",
      toolArgs: {
        command: `node "${path.join(packageRoot, "bin", "cli.js")}" --help`,
        workdir: packageRoot,
      },
      turnId: "turn-c",
      callId: "call-write",
    });
    pendingApprovalCallIds.set("call-write", "pending-write");

    approval.confirmSessionApprovalForRecentEvents({
      recentRequireEscalatedEvents,
      runtime: { log: () => {} },
      sessionApprovalGrants,
      sessionId: "session-c",
      source: "tui_exec_approval",
      turnId: "turn-c",
      nowMs,
    });

    const cancelled = approval.cancelPendingApprovalNotificationsBySuppression({
      runtime: { log: () => {} },
      pendingApprovalNotifications,
      pendingApprovalCallIds,
      sessionId: "session-c",
      turnId: "turn-c",
      nowMs,
      sessionApprovalGrants,
    });

    assert(cancelled === 1);
    assert(!pendingApprovalNotifications.has("pending-read"));
    assert(pendingApprovalNotifications.has("pending-write"));
    assert(pendingApprovalCallIds.get("call-write") === "pending-write");
  });

  test("session approval suppression does not hide different roots or non-read-only commands", () => {
    const recentRequireEscalatedEvents = new Map();
    const sessionApprovalGrants = new Map();
    const nowMs = 2_000_000;
    const packageRoot = ROOT;
    const otherRoot = "C:\\other-project";

    approval.rememberRecentRequireEscalatedEvent(
      recentRequireEscalatedEvents,
      {
        dedupeKey: "session-b|exec|turn-b|Get-Content",
        eventType: "require_escalated_tool_call",
        projectDir: packageRoot,
        sessionId: "session-b",
        toolArgs: {
          command: `Get-Content -Path '${path.join(packageRoot, "README.md")}'`,
          workdir: packageRoot,
        },
        turnId: "turn-b",
      },
      nowMs - 1_000
    );

    approval.confirmSessionApprovalForRecentEvents({
      recentRequireEscalatedEvents,
      runtime: { log: () => {} },
      sessionApprovalGrants,
      sessionId: "session-b",
      source: "tui_exec_approval",
      turnId: "turn-b",
      nowMs,
    });

    assert(
      approval.getSessionRequireEscalatedSuppressionReason({
        event: {
          eventType: "require_escalated_tool_call",
          sessionId: "session-b",
          toolArgs: {
            command: `Get-Content -Path '${path.join(otherRoot, "README.md")}'`,
            workdir: otherRoot,
          },
        },
        nowMs: nowMs + 500,
        sessionApprovalGrants,
      }) === ""
    );

    assert(
      approval.getSessionRequireEscalatedSuppressionReason({
        event: {
          eventType: "require_escalated_tool_call",
          sessionId: "session-b",
          toolArgs: {
            command: `node "${path.join(packageRoot, "bin", "cli.js")}" --help`,
            workdir: packageRoot,
          },
        },
        nowMs: nowMs + 500,
        sessionApprovalGrants,
      }) === ""
    );
  });

  test("approval_policy=never suppresses require_escalated approval notifications", () => {
    assert(
      approval.getCodexRequireEscalatedSuppressionReason({
        event: {
          eventType: "require_escalated_tool_call",
          toolArgs: {
            command: "Get-Date",
          },
        },
        approvalPolicy: "never",
        sandboxPolicy: null,
        approvedCommandRules: [],
      }) === "approval_policy_never"
    );
  });

  test("danger-full-access suppresses require_escalated approval notifications", () => {
    assert(
      approval.getCodexRequireEscalatedSuppressionReason({
        event: {
          eventType: "require_escalated_tool_call",
          toolArgs: {
            command: "Get-Date",
          },
        },
        approvalPolicy: "",
        sandboxPolicy: {
          type: "danger-full-access",
        },
        approvedCommandRules: [],
      }) === "danger_full_access"
    );
  });
};
