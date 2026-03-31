## Deprecated. This package has moved to `@erica-s/ai-agent-notify`.

# claude-code-notify

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

- Prefer a global install. `npx --yes @erica_s/claude-code-notify` is less
  reliable in async hooks.
- The click-to-activate protocol is registered automatically on install.

## Codex

Recommended `~/.codex/config.toml`:

```toml
notify = ["claude-code-notify"]

[mcp_servers.claude_code_notify_sidecar]
command = "cmd.exe"
args = ["/d", "/c", "claude-code-notify", "codex-mcp-sidecar"]
required = false
startup_timeout_sec = 5
```

- `notify = ["claude-code-notify"]` covers completion events such as
  `agent-turn-complete`.
- `codex-session-watch` is the main path for approval reminders.
- `codex-mcp-sidecar` will usually auto-start `codex-session-watch`.
- Do **not** set `cwd` on the MCP server entry above.
- After changing Codex `notify`, restart Codex and retest in a fresh TUI
  session.
- Prefer a global install. `npx.cmd @erica_s/claude-code-notify` is less reliable on Windows.

If you are not using the MCP sidecar, start the watcher yourself:

```bash
claude-code-notify codex-session-watch
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
