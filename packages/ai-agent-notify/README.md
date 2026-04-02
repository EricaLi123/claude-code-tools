# ai-agent-notify

Windows Toast notifications for Claude Code and Codex.

Get notified when Claude or Codex finishes a task, or when Codex requests
approval.

## Install

```bash
volta install @erica-s/ai-agent-notify
# or
npm install -g @erica-s/ai-agent-notify
```

Use `ai-agent-notify.cmd` for Windows direct process launch entries such as
Codex `notify` and MCP `command`.

## Claude Code

Add to your `~/.claude/settings.json`:

```json
{
    "hooks": {
        "Stop": [{ "hooks": [{ "type": "command", "command": "ai-agent-notify.cmd", "async": true }] }],
        "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "ai-agent-notify.cmd", "async": true }] }]
    }
}
```

- `Stop` sends notifications when a Claude Code task finishes.
- `PermissionRequest` sends notifications when Claude Code needs approval.
- Remove either hook if you only want one of those two behaviors.

## Codex

- `notify = [...]` covers completion notifications.
- Add the `ai_agent_notify_sidecar` block if you also want approval reminders
  and window / tab return guidance.
- If you only care about completion notifications, you can omit the sidecar
  block.

`~/.codex/config.toml`:

```toml
notify = ["ai-agent-notify.cmd"]

[mcp_servers.ai_agent_notify_sidecar]
command = "ai-agent-notify.cmd"
args = ["codex-mcp-sidecar"]
required = false
startup_timeout_sec = 30
```

- `codex-session-watch` is the main path for approval reminders.
- `codex-mcp-sidecar` will usually auto-start `codex-session-watch`.
- Do **not** set `cwd` on the MCP server entry above.

## Requirements

- Windows 10 / 11
- Node.js >= 16
- PowerShell 5.1+

## Known Limitations

- **Very long Codex sessions:** completion notifications on Windows can stop firing after a very long session; `clear` or start a new session if this happens
- **Toast source** shows as "Windows PowerShell" instead of "Claude Code"
- **Windows 10:** `Open` may not work due to OS limitations
- **macOS / Linux:** not supported

## Documentation

- Design and development docs: [`docs/README.md`](./docs/README.md)

## License

MIT
