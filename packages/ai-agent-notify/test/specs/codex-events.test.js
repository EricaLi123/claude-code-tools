module.exports = function runCodexEventTests(h) {
  const { assert, cli, section, test, TEST_PACKAGE_DIR } = h;

  section("Codex events");

  test("session watcher queues response_item function_call approvals for pending confirmation", () => {
    const event = cli.buildCodexSessionEvent(
      {
        filePath:
          "C:\\Users\\ericali\\.codex\\sessions\\2026\\03\\20\\rollout-2026-03-20T12-14-50-session-1.jsonl",
        sessionId: "session-1",
        cwd: "C:\\Users\\ericali",
        turnId: "turn-1",
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-1",
          arguments: JSON.stringify({
            command: "Get-Date",
            sandbox_permissions: "require_escalated",
            workdir: "C:\\Users\\ericali",
          }),
        },
      }
    );

    assert(event);
    assert(event.eventName === "PermissionRequest");
    assert(event.eventType === "require_escalated_tool_call");
    assert(event.approvalDispatch === "pending");
    assert(event.turnId === "turn-1");
    assert(event.dedupeKey === "session-1|exec|turn-1|shell_command:Get-Date");
  });

  test("session watcher ignores non-escalated function_call response items", () => {
    const event = cli.buildCodexSessionEvent(
      {
        filePath:
          "C:\\Users\\ericali\\.codex\\sessions\\2026\\03\\20\\rollout-2026-03-20T12-14-50-session-2.jsonl",
        sessionId: "session-2",
        cwd: "C:\\Users\\ericali",
        turnId: "turn-2",
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-2",
          arguments: JSON.stringify({
            command: "Get-Date",
            workdir: "C:\\Users\\ericali",
          }),
        },
      }
    );

    assert(event === null);
  });

  test("tui watcher recognizes shell approvals from ToolCall lines instead of exec_approval dispatch", () => {
    const event = cli.buildCodexTuiApprovalEvent(
      { applyPatchCapture: null },
      '2026-03-20T04:15:29.835774Z  INFO session_loop{thread_id=session-3}:submission_dispatch{otel.name="op.dispatch.user_turn" submission.id="submission-3" codex.op="user_turn"}:turn{otel.name="session_task.turn" thread.id=session-3 turn.id=turn-3 model=gpt-5.4}: codex_core::stream_events_utils: ToolCall: shell_command {"command":"Get-Date","sandbox_permissions":"require_escalated","workdir":"C:\\\\Users\\\\ericali"} thread_id=session-3',
      {
        sessionProjectDirs: new Map([["session-3", "C:\\Users\\ericali"]]),
        sessionApprovalContexts: new Map(),
      }
    );

    assert(event);
    assert(event.eventType === "require_escalated_tool_call");
    assert(event.approvalDispatch === "pending");
    assert(event.dedupeKey === "session-3|exec|turn-3|shell_command:Get-Date");
  });

  test("session watcher recognizes explicit apply_patch approval events from rollout JSONL", () => {
    const event = cli.buildCodexSessionEvent(
      {
        filePath:
          "C:\\Users\\ericali\\.codex\\sessions\\2026\\03\\20\\rollout-2026-03-20T12-14-50-session-4.jsonl",
        sessionId: "session-4",
        cwd: "C:\\Users\\ericali",
        turnId: "turn-4",
      },
      {
        type: "event_msg",
        payload: {
          type: "apply_patch_approval_request",
          turn_id: "turn-4",
          call_id: "call-4",
          approval_id: "approval-4",
          cwd: TEST_PACKAGE_DIR,
        },
      }
    );

    assert(event);
    assert(event.eventType === "apply_patch_approval_request");
    assert(event.dedupeKey === "session-4|patch|turn-4|");
  });

  test("session watcher recognizes request_user_input prompts from rollout JSONL", () => {
    const promptText = "What plan should I use for the next step?";
    const event = cli.buildCodexSessionEvent(
      {
        filePath:
          "C:\\Users\\ericali\\.codex\\sessions\\2026\\04\\03\\rollout-2026-04-03T16-04-13-session-input.jsonl",
        sessionId: "session-input",
        cwd: "D:\\tmp",
        turnId: "turn-input",
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call-input",
          arguments: JSON.stringify({
            questions: [
              {
                header: "Plan Type",
                id: "plan_target",
                question: promptText,
              },
            ],
          }),
        },
      }
    );

    assert(event);
    assert(event.eventName === "InputRequest");
    assert(event.title === "Input Needed");
    assert(event.message === promptText);
    assert(event.eventType === "request_user_input");
    assert(event.dedupeKey === "session-input|input|turn-input|request_user_input:plan_target:1");
  });

  test("tui watcher ignores apply_patch tool calls because they are not reliable approval signals", () => {
    const event = cli.buildCodexTuiApprovalEvent(
      {},
      '2026-03-20T09:24:55.432022Z  INFO session_loop{thread_id=session-5}:submission_dispatch{otel.name="op.dispatch.user_turn" submission.id="submission-5" codex.op="user_turn"}:turn{otel.name="session_task.turn" thread.id=session-5 turn.id=turn-5 model=gpt-5.4}: codex_core::stream_events_utils: ToolCall: apply_patch *** Begin Patch',
      {
        sessionProjectDirs: new Map([["session-5", "C:\\Users\\ericali"]]),
      }
    );

    assert(event === null);
  });

  test("tui watcher recognizes request_user_input prompts", () => {
    const promptText = "What plan should I use for the next step?";
    const event = cli.buildCodexTuiInputEvent(
      {},
      `2026-04-03T08:04:51.916797Z  INFO session_loop{thread_id=session-input}:submission_dispatch{otel.name="op.dispatch.user_input" submission.id="submission-input" codex.op="user_input"}:turn{otel.name="session_task.turn" thread.id=session-input turn.id=turn-input model=gpt-5.4}: codex_core::stream_events_utils: ToolCall: request_user_input {"questions":[{"header":"Plan Type","id":"plan_target","question":"${promptText}","options":[{"label":"Project Plan (Recommended)","description":"Inspect D:\\\\tmp\\\\ai-ui-case-runner-work before finalizing the plan."}]}]} thread_id=session-input`,
      {
        sessionProjectDirs: new Map([["session-input", "D:\\tmp"]]),
      }
    );

    assert(event);
    assert(event.eventName === "InputRequest");
    assert(event.title === "Input Needed");
    assert(event.message === promptText);
    assert(event.eventType === "request_user_input");
    assert(event.dedupeKey === "session-input|input|turn-input|request_user_input:plan_target:1");
  });
};
