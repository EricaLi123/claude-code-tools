module.exports = function runCodexEventTests(h) {
  const { assert, events, path, ROOT, section, test, TEST_PACKAGE_DIR } = h;

  section("Codex events");

  test("session watcher ignores require_escalated rollout function calls", () => {
    const event = events.buildCodexSessionEvent(
      {
        filePath:
          "C:\\Users\\ericali\\.codex\\sessions\\2026\\03\\20\\rollout-2026-03-20T12-14-50-session-1.jsonl",
        sessionId: "session-1",
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

    assert(event === null);
  });

  test("session watcher ignores explicit rollout approval request events", () => {
    const event = events.buildCodexSessionEvent(
      {
        filePath:
          "C:\\Users\\ericali\\.codex\\sessions\\2026\\03\\20\\rollout-2026-03-20T12-14-50-session-4.jsonl",
        sessionId: "session-4",
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

    assert(event === null);
  });

  test("session watcher ignores rollout task_complete event_msg records", () => {
    const event = events.buildCodexSessionEvent(
      {
        filePath:
          "C:\\Users\\ericali\\.codex\\sessions\\2026\\04\\09\\rollout-2026-04-09T16-20-00-session-stop.jsonl",
        sessionId: "session-stop",
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-stop",
          cwd: TEST_PACKAGE_DIR,
        },
      }
    );

    assert(event === null);
  });

  test("session watcher recognizes request_user_input prompts from rollout JSONL", () => {
    const promptText = "What plan should I use for the next step?";
    const event = events.buildCodexSessionEvent(
      {
        filePath:
          "C:\\Users\\ericali\\.codex\\sessions\\2026\\04\\03\\rollout-2026-04-03T16-04-13-session-input.jsonl",
        sessionId: "session-input",
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
    assert(event.agentId === "codex");
    assert(event.entryPointId === "rollout-watch");
    assert(!("source" in event));
    assert(!("projectDir" in event));
    assert(event.eventName === "QuestionNotification");
    assert(event.title === "Input Needed");
    assert(event.message === promptText);
    assert(event.eventType === "request_user_input");
    assert(!("turnId" in event));
    assert(!("dedupeKey" in event));
  });

  test("session handler emits rollout QuestionNotification events immediately in live state", () => {
    const handlersPath = path.join(ROOT, "lib", "codex-session-watch-handlers.js");
    const notifyPath = path.join(ROOT, "lib", "codex-session-watch-notify.js");
    const handlersModuleKey = require.resolve(handlersPath);
    const notifyModule = require(notifyPath);
    const originalEmit = notifyModule.emitCodexSessionWatchNotification;
    const emitted = [];
    notifyModule.emitCodexSessionWatchNotification = ({ event }) => {
      emitted.push(event);
      return true;
    };

    try {
      delete require.cache[handlersModuleKey];
      const handlers = require(handlersPath);

      handlers.handleSessionRecord(
        {
          filePath:
            "C:\\Users\\ericali\\.codex\\sessions\\2026\\04\\03\\rollout-2026-04-03T16-04-13-session-live-input.jsonl",
          sessionId: "session-live-input",
        },
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            call_id: "call-live-input",
            arguments: JSON.stringify({
              questions: [
                {
                  header: "Plan Type",
                  id: "plan_target",
                  question: "What plan should I use for the next step?",
                },
              ],
            }),
          },
        }),
        {
          runtime: { log: () => {} },
          terminal: { hwnd: null, shellPid: null, isWindowsTerminal: false },
        }
      );

      assert(emitted.length === 1, "live handler path should emit one QuestionNotification");
      assert(emitted[0].eventName === "QuestionNotification");
      assert(emitted[0].entryPointId === "rollout-watch");
      assert(!("turnId" in emitted[0]));
    } finally {
      notifyModule.emitCodexSessionWatchNotification = originalEmit;
      delete require.cache[handlersModuleKey];
      require(handlersPath);
    }
  });

  test("session watcher send path emits repeated QuestionNotification observations without dedupe state", () => {
    const sessionWatchNotify = require(path.join(ROOT, "lib", "codex-session-watch-notify.js"));
    const notifications = [];
    const child = {
      on: () => child,
    };
    const event = {
      agentId: "codex",
      entryPointId: "rollout-watch",
      eventName: "QuestionNotification",
      title: "Input Needed",
      message: "What plan should I use for the next step?",
      eventType: "request_user_input",
      sessionId: "session-input",
    };

    const first = sessionWatchNotify.emitCodexSessionWatchNotification({
      event,
      runtime: { log: () => {} },
      terminal: { hwnd: null, shellPid: null, isWindowsTerminal: false },
      origin: "session",
      resolveSessionWatchTerminalContextImpl: ({ fallbackTerminal }) => fallbackTerminal,
      emitNotificationImpl: (payload) => {
        notifications.push(payload);
        return child;
      },
    });
    const second = sessionWatchNotify.emitCodexSessionWatchNotification({
      event,
      runtime: { log: () => {} },
      terminal: { hwnd: null, shellPid: null, isWindowsTerminal: false },
      origin: "session-repeat",
      resolveSessionWatchTerminalContextImpl: ({ fallbackTerminal }) => fallbackTerminal,
      emitNotificationImpl: (payload) => {
        notifications.push(payload);
        return child;
      },
    });

    assert(first === true);
    assert(second === true);
    assert(notifications.length === 2);
    assert(notifications[0].entryPointId === "rollout-watch");
    assert(notifications[1].entryPointId === "rollout-watch");
  });

};
