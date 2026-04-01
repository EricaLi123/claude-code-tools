# Codex Approval Notification Session

Date: 2026-03-18

Repo:
- `D:\Git\claude-code-tools`

Package:
- `D:\Git\claude-code-tools\packages\claude-code-notify`

## 为什么保留这页

这页保留的价值，不是因为里面的实现后来成了主路线，而是因为它把 `app-server` 路线为什么没成为默认方案说明白了：

- 如果想靠 `app-server` 拿到 approval 事件，用户通常就不能只是“配一次，然后继续直接用官方 `codex`”，而是必须包一层宿主 / 包装器
- 如果不包这层，只是独立拉起一个 `codex app-server` watcher，它又不能全局观察其他 Codex 会话里的 approval

也正因为这两点，后续默认主路线才转向 `codex-session-watch`。

## 先看结论

- 当时试的是“基于官方 `app-server` 做 approval watcher”。
- 代码实现本身是成功的，协议也确实能看到 `waitingOnApproval`。
- 但这条线不满足“配置一次，此后无感继续直接用官方 `codex`”这个根本需求，因为默认要想稳定拿到事件，就必须把 Codex 包进额外一层。
- 同时，本次验证也证明：如果不包这层，只是独立启动 watcher，它只能看到自己启动的那条 app-server 连接，看不到别的 Codex 会话。
- 所以这条路被验证为“不适合作为默认全局 approval 路线”。

## Goal

Implement a local-only way for `@erica_s/claude-code-notify` to notify when Codex is waiting for approval, while continuing to use the official Codex package and explicitly avoiding:

- forking Codex
- patching Codex internals
- adding runtime dependencies to this package

## Starting Constraints

- Existing package behavior only handled the original stdin hook path.
- Existing package had zero runtime dependencies and tests asserted that.
- User wanted to keep using the official Codex package.
- User rejected any approach that required forking or patching Codex itself.

## Initial Options Considered

The investigation narrowed to three broad families:

- A. Watch Codex session files directly
- B. Integrate more deeply with request-level approval events from official `app-server`
- C. Use official `codex app-server`, but only watch thread status changes and notify when a thread enters `waitingOnApproval`

The chosen direction for implementation was `C`, because it was the least invasive official-interface approach.

## Protocol Research

Local generated schema / TS bindings were inspected:

- `C:\Users\Erica\codex-app-server-schema`
- `C:\Users\Erica\codex-app-server-ts`

Key findings:

- Official notifications include `thread/status/changed`
- Thread active flags include `waitingOnApproval`
- `turn/completed` also exists, but this session focused on approval notifications
- Lower-level approval request events also exist, but were not chosen for the first pass

Important protocol files referenced:

- `C:\Users\Erica\codex-app-server-ts\ServerNotification.ts`
- `C:\Users\Erica\codex-app-server-ts\v2\ThreadStatusChangedNotification.ts`
- `C:\Users\Erica\codex-app-server-ts\v2\ThreadStatus.ts`
- `C:\Users\Erica\codex-app-server-ts\v2\ThreadActiveFlag.ts`

## Implementation Work Done

The package was extended with a new explicit mode:

- `claude-code-notify codex-watch`

Behavior added in this session:

- starts official `codex app-server`
- sends `initialize`
- sends `initialized`
- bootstraps current threads with `thread/list`
- watches `thread/status/changed`
- when `activeFlags` contains `waitingOnApproval`, reuses the existing PowerShell notification path
- uses title override `Codex Needs Approval`
- deduplicates repeated notifications per thread while approval is still pending

Windows-specific launch compatibility was also added:

- resolve `codex` through `where.exe`
- handle Volta / npm shim cases
- if the resolved launcher is `.cmd` or `.bat`, use `cmd.exe /c`

Files modified during implementation:

- `packages/claude-code-notify/bin/cli.js`
- `packages/claude-code-notify/README.md`
- `packages/claude-code-notify/test/test-cli.js`

## Validation Performed

### Static / package validation

Commands run:

```powershell
node --check D:\Git\claude-code-tools\packages\claude-code-notify\bin\cli.js
node D:\Git\claude-code-tools\packages\claude-code-notify\test\test-cli.js
```

Observed result:

- `18 passed, 0 failed, 5 skipped`

Skipped items were due to sandbox restrictions around nested child processes.

### Local startup validation

`codex-watch` was started locally and confirmed to reach:

- `initialize`
- `initialized`
- `thread/list`

Observed watcher log sequence:

```text
app-server <= initialize id=req-1
app-server <= initialized
app-server <= thread/list id=req-2
```

This established that the package could launch official Codex and begin its own app-server session successfully.

### End-to-end approval probe

A second independent official `codex app-server` instance was then used to create a real thread and start a turn under:

- `approvalPolicy: "on-request"`
- read-only sandbox

Prompt used:

```text
Create a file named approval-probe.txt in the current directory containing the single line hello.
```

That probe definitively produced:

```json
{
  "method": "thread/status/changed",
  "params": {
    "status": {
      "type": "active",
      "activeFlags": ["waitingOnApproval"]
    }
  }
}
```

It also produced an explicit approval request:

- `item/commandExecution/requestApproval`

## Final Finding

The critical result of the session:

- the independent probe app-server saw `waitingOnApproval`
- the background `claude-code-notify codex-watch` process did not see that external thread transition

The watcher only observed the app-server instance it launched itself. It did not receive events from a separate Codex app-server / session.

## Conclusion

The implemented `app-server watcher` proves that:

- official app-server integration works locally for the watcher's own connection
- official `thread/status/changed` notifications do contain `waitingOnApproval`

But it also proves that this specific non-invasive design does **not** satisfy the real user goal of globally observing approval requests from other Codex sessions.

Therefore, the current result is:

- `scheme C` was implemented successfully as code
- `scheme C` was invalidated for the actual use case by end-to-end testing

## Current Recommendation

If the requirement remains:

- keep using the official Codex package
- do not fork Codex
- do not patch Codex internals

Then the remaining viable direction is:

- watch Codex session files (`sessions/*.jsonl`) instead of relying on a separately launched `app-server` instance

## Session Summary

User intent over this session:

1. Keep using the official Codex package
2. Avoid fork / patch approaches
3. Investigate official-code-based non-invasive solutions
4. Implement the selected path in `packages/claude-code-notify`
5. Verify whether it actually works end to end

What was learned:

1. Official Codex app-server exposes the right approval-related status
2. A standalone watcher process can launch and talk to official app-server
3. That watcher does not act as a global observer for approvals originating in other Codex sessions
4. The architecture failure is in the approach boundary, not in local installation or Windows command resolution

## Follow-up (2026-03-20)

This conclusion remained relevant after later package iterations.

- The package later added `codex-session-watch` and that became the primary approval path for normal Codex CLI usage.
- `codex-watch` was retained as a narrower app-server-scoped / debugging mode, not as the default global approval watcher.
- A later review also recorded that single-`cwd` mode in `codex-watch` only applies the `cwd` filter during bootstrap `thread/list`; live `thread/status/changed` notifications do not carry `cwd`, so project scoping in that mode is best-effort rather than a strict guarantee.
