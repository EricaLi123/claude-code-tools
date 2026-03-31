# claude-code-notify

Windows Toast notifications for Claude Code and Codex.

Get notified when Claude or Codex finishes a task, or when a watcher sees an
approval request.

## What It Does

- Claude Code completion and permission-request notifications
- Codex completion notifications through direct `notify`
- Codex approval reminders through `codex-session-watch`
- Return-to-terminal helpers: toast title, taskbar flash, and "Open"

## Features

- **Toast notification** — native WinRT toast, no BurntToast or other modules needed
- **Taskbar flash + Open button** — easier to get back to the right terminal
- **Automatic shell detection** — usually no manual PID override needed
- **Zero dependencies** — pure PowerShell + WinRT, nothing else to install

## Install

```bash
# Recommended: global install via volta or npm
volta install @erica_s/claude-code-notify
# or
npm install -g @erica_s/claude-code-notify
```

## Claude Code

Add to your `~/.claude/settings.json`:

```json
{
    "hooks": {
        "Stop": [{ "hooks": [{ "type": "command", "command": "claude-code-notify", "async": true }] }],
        "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "claude-code-notify", "async": true }] }]
    }
}
```

- Global install is recommended. `npx --yes @erica_s/claude-code-notify`
  can lose stdin on first-run download delays in async hooks.
- `--shell-pid <pid>` and `TOAST_NOTIFY_SHELL_PID` still exist for debugging,
  but normal usage should not need them.
- The click-to-activate protocol is registered automatically on install.

Manual smoke tests:

```bash
echo '{"hook_event_name":"Stop","session_id":"test-stop"}' | claude-code-notify
echo '{"hook_event_name":"PermissionRequest","session_id":"test-permission"}' | claude-code-notify
```

## Codex Direct Notify

Use this in `~/.codex/config.toml`:

```toml
notify = ["claude-code-notify"]
```

- After changing Codex `notify`, restart Codex and retest in a fresh TUI
  session. Already-running sessions keep the command they resolved at session
  start.
- Do not use `npx.cmd @erica_s/claude-code-notify` here if you need return-to-
  terminal behavior. That path can still send a Toast, but window flash, "Open",
  and Windows Terminal tab highlight may fall back because `hwnd` / `shellPid`
  are not recovered reliably through the extra `npx` process chain.
- On Windows, extremely long-lived Codex sessions can also make the legacy
  completion payload large enough to trip the same argv limit. A local repro on
  March 31, 2026 came from a session that had been kept open for about 15 days;
  running `clear` and retrying in a fresh session immediately recovered. Treat
  that as a current limitation of legacy `notify` on Windows.

Important limitation: Codex's current legacy `notify` hook only emits the
completion payload such as `agent-turn-complete`. It cannot signal approval
requests. For approval notifications in normal Codex CLI usage, configure
`codex-mcp-sidecar` and `codex-session-watch` below.

## Codex MCP Sidecar (Recommended)

The sidecar preserves startup-time terminal hints for later approval
localization and can hidden-launch `codex-session-watch` when needed.
Completion notifications do not depend on it.

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.claude_code_notify_sidecar]
command = "cmd.exe"
args = ["/d", "/c", "claude-code-notify", "codex-mcp-sidecar"]
required = false
startup_timeout_sec = 5
```

- Do **not** set `cwd` on this MCP server entry. Leaving `cwd` unset lets the
  sidecar inherit the real Codex project directory, which is how it matches the
  correct rollout session later.

Practical notes:

- On session startup, the sidecar will hidden-launch `codex-session-watch` if
  that watcher is not already running.
- The sidecar helps approval localization only. It does **not** replace
  `codex-session-watch`, and it does not affect completion notifications.
- If the watcher cannot recover an exact session match from the sidecar record,
  the approval reminder still fires but may fall back to Toast-only behavior.

For implementation details and design trade-offs, see
[`docs/development.md`](https://github.com/EricaLi123/claude-code-tools/blob/main/packages/claude-code-notify/docs/development.md).

## Codex Session Watcher (Recommended For Approval Notifications)

This is the primary path for Codex approval reminders. It tails local rollout
files under `~/.codex/sessions` and the Codex TUI log under
`~/.codex/log/codex-tui.log`, then sends a notification when Codex requests
approval:

```bash
claude-code-notify codex-session-watch
```

If you configured `codex-mcp-sidecar`, you usually do **not** need to start
this manually. The first Codex session in the current Windows login will
auto-start it in the background.

If you are not using the MCP sidecar, start `codex-session-watch` yourself in a
separate terminal before opening the Codex session you want to observe.

Optional flags:

- `--sessions-dir <path>`: override the Codex sessions directory
- `--tui-log <path>`: override the Codex TUI log path
- `--poll-ms <ms>`: change the polling interval

Practical notes:

- `codex-session-watch` is the main path for approval reminders, not completion
  notifications.
- Some very fast or already-approved escalation events may be suppressed to
  reduce false positives.
- For the detailed signal heuristics and suppression rules, see
  [`docs/development.md`](https://github.com/EricaLi123/claude-code-tools/blob/main/packages/claude-code-notify/docs/development.md).

> **Note:** by itself, session-watcher mode runs outside the original Codex
> terminal process, so it may have to fall back to Toast-only behavior. With
> `codex-mcp-sidecar`, it can sometimes reuse exact terminal context and the
> sidecar also auto-starts the watcher when a Codex session begins.

## Common Commands

```bash
claude-code-notify --help
claude-code-notify codex-session-watch
claude-code-notify codex-mcp-sidecar
claude-code-notify codex-watch
```

## Codex App-Server Watcher (Scoped / Advanced)

Start a long-running watcher that launches the official `codex app-server`
and sends a notification whenever a Codex thread enters
`waitingOnApproval`:

```bash
claude-code-notify codex-watch
```

By default, `codex-watch` only watches threads whose cwd matches the current
directory. To watch every interactive Codex thread instead:

```bash
claude-code-notify codex-watch --all-cwds
```

Optional flags:

- `--cwd <path>`: watch a specific project directory
- `--codex-bin <path>`: override the Codex executable
- `--shell-pid <pid>`: keep the existing manual shell PID override behavior

This mode is kept for app-server-scoped workflows and protocol debugging. In
this project's end-to-end validation, a watcher that launched its own
`codex app-server` did not behave as a global observer for approval requests
originating in other Codex sessions. For stock Codex CLI usage, prefer
`codex-session-watch`.

For protocol details and internal flow, see [`docs/development.md`](https://github.com/EricaLi123/claude-code-tools/blob/main/packages/claude-code-notify/docs/development.md).

## Requirements

- Windows 10 / 11
- Node.js >= 16
- PowerShell 5.1+

## Known Limitations

- **Toast source** shows as "Windows PowerShell" instead of "Claude Code" (required for toast to display on Windows 10)
- **Windows 10**: Click-to-activate ("Open" button) may not work due to OS limitations
- **macOS / Linux**: Not supported

## License

MIT
