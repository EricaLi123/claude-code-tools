# ai-agent-notify

Windows Toast notifications for Claude Code and Codex.

Get notified when a Claude or Codex turn completes, when Claude needs
approval, and when Codex needs approval or input.

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

- `Stop` sends notifications when a Claude Code turn completes.
- `PermissionRequest` sends notifications when Claude Code needs approval.
- Remove either hook if you only want one of those two behaviors.

## Codex

- `notify = [...]` remains the primary path for Codex turn-complete notifications.
- Official Codex hooks handle `PermissionRequest` and `Stop`.
- Add the `ai_agent_notify_sidecar` block if you also want watcher-backed input
  prompts for `InputRequest`.
- If you only care about turn-complete notifications and hook-based approval
  prompts, omit the sidecar block; `notify` plus hooks still work on their own.

`~/.codex/config.toml`:

```toml
[features]
codex_hooks = true

notify = ["ai-agent-notify.cmd"]

[mcp_servers.ai_agent_notify_sidecar]
command = "ai-agent-notify.cmd"
args = ["codex-mcp-sidecar"]
required = false
startup_timeout_sec = 30
```

Optional official Codex hooks:

`~/.codex/hooks.json`:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          { "type": "command", "command": "ai-agent-notify.cmd", "timeout": 2 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "ai-agent-notify.cmd", "timeout": 2 }
        ]
      }
    ]
  }
}
```

- `codex-session-watch` only handles `InputRequest` input prompts.
- watcher 只处理 `InputRequest`，并继续同时读取 rollout JSONL 和
  `codex-tui.log` 两条本地信号。
- Codex 官方 hooks 还需要 `config.toml` 里的 `features.codex_hooks = true`；
  只写 `hooks.json` 不会生效。
- Codex 当前会跳过带 `async: true` 的 hooks；这里要写同步 command hook。
- Codex command hook 是同步的；如果不想 UI 等完整个通知流程，直接在
  `hooks.json` 里给 hook 配 `timeout`，当前建议值是 `2` 秒。
- `codex-mcp-sidecar` will usually auto-start `codex-session-watch`.
- 归一化事件字段里，`agentId` 只表示 agent 来源，例如 `claude`、`codex`、
  `unknown`；代码入口统一记录在 `entryPointId`，例如 `notify-mode`、
  `hooks-mode`、`rollout-watch`、`tui-watch`。
- 面向用户的显示标签只由这两部分组合出来，不再单独保留 `source` 字段。
- Do **not** set `cwd` on the MCP server entry above.

## Requirements

- Windows 10 / 11
- Node.js >= 16
- PowerShell 5.1+

## Known Limitations

- **Very long Codex sessions:** turn-complete notifications on Windows can stop firing after a very long session; `clear` or start a new session if this happens.
- **Toast source** shows as "Windows PowerShell" instead of "Claude Code"
- **Windows 10:** `Open` may not work due to OS limitations
- **macOS / Linux:** not supported

## Documentation

- Design and development docs: [`docs/README.md`](./docs/README.md)

## License

MIT
