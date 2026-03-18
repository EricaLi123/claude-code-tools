# Codex Approval Notification Session

Date: 2026-03-18

Repo:
- `D:\Git\claude-code-tools`

Package:
- `D:\Git\claude-code-tools\packages\claude-code-notify`

## Goal

Implement a local-only way for `@erica_s/claude-code-notify` to notify when Codex is waiting for approval, while continuing to use the official Codex package and explicitly avoiding:

- forking Codex
- patching Codex internals
- adding runtime dependencies to this package

## Starting Constraints

- Existing package behavior was Claude-hook-only.
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
