# ai-agent-notify

Windows Toast notifications for Claude Code and Codex.

Get notified when Claude or Codex finishes a task, or when Codex requests
approval.

## Problem It Solves

Claude Code sessions can run for a long time. Once you switch to other windows,
it becomes easy to miss state changes in the original terminal. This package
solves two core problems:

### 1. Reminder

- Native Windows Toast notifications
- Taskbar flashing

### 2. Return To The Session

- Notification titles make the source and result easy to identify
- The matching terminal window flashes as a visual cue
- The notification provides an `Open` button that activates the target window

## Install

The configs below use `npx.cmd` so they can pick up the latest published
package automatically. If you want a fixed local binary instead, install it
globally:

```bash
volta install @erica-s/ai-agent-notify
# or
npm install -g @erica-s/ai-agent-notify
```

## Claude Code

Add to your `~/.claude/settings.json`:

```json
{
    "hooks": {
        "Stop": [{ "hooks": [{ "type": "command", "command": "npx.cmd @erica-s/ai-agent-notify", "async": true }] }],
        "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "npx.cmd @erica-s/ai-agent-notify", "async": true }] }]
    }
}
```

- This is the current recommended path because it auto-updates with the latest
  published package.
- If `npx` startup or first-run download latency becomes a problem on your
  machine, switch the hook command to `ai-agent-notify` after a global install.
- The click-to-activate protocol is registered automatically on install.

## Codex

Recommended `~/.codex/config.toml`:

```toml
notify = ["npx.cmd", "@erica-s/ai-agent-notify"]

[mcp_servers.ai_agent_notify_sidecar]
command = "npx.cmd"
args = ["@erica-s/ai-agent-notify", "codex-mcp-sidecar"]
required = false
startup_timeout_sec = 30
```

- `notify = ["npx.cmd", "@erica-s/ai-agent-notify"]` covers completion events such as
  `agent-turn-complete`.
- `startup_timeout_sec = 30` leaves headroom for the extra `npx` startup hop.
- Current local Windows validation on April 1, 2026 shows this `npx` route
  working again for completion notify and sidecar startup.
- The reason it currently works again, compared with older machine-specific
  failures, is still unknown. If your machine regresses, switch back to a
  globally installed `ai-agent-notify`.
- `codex-session-watch` is the main path for approval reminders.
- `codex-mcp-sidecar` will usually auto-start `codex-session-watch`.
- Do **not** set `cwd` on the MCP server entry above.
- After changing Codex `notify`, restart Codex and retest in a fresh TUI
  session.

If you are not using the MCP sidecar, start the watcher yourself:

```bash
npx.cmd @erica-s/ai-agent-notify codex-session-watch
```

Optional flags:

- `--sessions-dir <path>`: override the Codex sessions directory
- `--tui-log <path>`: override the Codex TUI log path
- `--poll-ms <ms>`: change the polling interval

## Requirements

- Windows 10 / 11
- Node.js >= 16
- PowerShell 5.1+

## Known Limitations

- **Toast source** shows as "Windows PowerShell" instead of "Claude Code"
- **Windows 10:** `Open` may not work due to OS limitations
- **macOS / Linux:** not supported

## License

MIT
