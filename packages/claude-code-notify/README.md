# claude-code-notify

Windows Toast notifications for Claude Code and Codex.

Get notified when Claude or Codex finishes a task, or when a watcher sees an
approval request.

This package now also supports Codex integration modes for:

- handling Codex direct `notify` payloads passed as a JSON argv argument for completion notifications
- handling Codex completion payloads through an installed PowerShell wrapper when Windows shim layers are not argv-safe
- recording startup-time terminal hints through an auto-started `codex-mcp-sidecar` MCP sidecar for later approval localization
- watching local Codex rollout session files and TUI logs for approval notifications through `codex-session-watch`
- watching `waitingOnApproval` through the official `codex app-server` connection launched by this package through `codex-watch`

## 解决什么问题

Claude Code 会话可能长时间运行，用户切到其他窗口后无法感知状态变化。本工具解决两个核心问题：

### 1. 提醒 — 让用户知道某个会话需要关注

- 系统原生 Toast 通知
- 任务栏闪烁

### 2. 定位 — 帮助用户找到并回到该会话

- 通知标题包含来源和事件结果，便于识别
- 闪烁对应的终端窗口，视觉引导
- 通知提供 "Open" 按钮，点击直接激活目标窗口

## Features

- **Toast notification** — native WinRT toast, no BurntToast or other modules needed
- **Taskbar flash** — flashes the terminal window until you switch to it
- **Click to activate** — click "Open" on the toast to jump back to the terminal
- **Automatic shell PID detection for tab color** — targets the current terminal shell without requiring manual PID arguments
- **Automatic Windows Terminal tab color reset** — keeps the highlight until that same tab comes back to foreground and emits new console input, then clears it without touching the foreground shell input
- **Zero dependencies** — pure PowerShell + WinRT, nothing else to install
- **Deep process tree walk** — reliably finds the terminal window even through volta/npx/bash shim chains

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

> **Note:** `npx --yes @erica_s/claude-code-notify` also works, but the download delay on first run may cause stdin data to be lost in async hooks. Global install is recommended for reliability.
>
> **Override:** `--shell-pid <pid>` and `TOAST_NOTIFY_SHELL_PID` are supported for debugging or special launchers, but normal usage no longer requires them. Shell detection now prefers current-console detection and falls back to the parent-process shell chain when needed.

The click-to-activate protocol is registered automatically on install.

Manual smoke tests:

```bash
echo '{"hook_event_name":"Stop","session_id":"test-stop"}' | claude-code-notify
echo '{"hook_event_name":"PermissionRequest","session_id":"test-permission"}' | claude-code-notify
```

## Codex Direct Notify

Codex `notify` executes a program directly and appends a JSON payload as the
final argv argument. This package understands that payload in its default mode.
The current recommended config is:

```toml
notify = ["npx.cmd", "@erica_s/claude-code-notify"]
```

If you already have the package exposed as `claude-code-notify` in `PATH`,
direct invocation still works:

```toml
notify = ["claude-code-notify"]
```

- After changing Codex `notify`, restart Codex and retest in a fresh TUI
  session. Already-running sessions keep the command they resolved at session
  start.

Important limitation: Codex's current legacy `notify` hook only emits the
completion payload such as `agent-turn-complete`. It cannot signal approval
requests. For approval notifications in normal Codex CLI usage, configure
`codex-mcp-sidecar` and `codex-session-watch` below.

If your Codex runtime cannot resolve `claude-code-notify` from `PATH`, point
`notify` to the full `.cmd` shim path or a wrapper script instead.

For example on Windows with a normal global npm install, the shim is typically:

```text
C:\Users\<you>\AppData\Roaming\npm\claude-code-notify.cmd
```

## Codex MCP Sidecar (Recommended)

`codex-session-watch` remains the actual approval detector. The sidecar exists
to auto-start that watcher when needed and preserve startup-time terminal hints
for later approval localization. Completion notifications do not depend on this
sidecar.

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.claude_code_notify_sidecar]
command = "claude-code-notify"
args = ["codex-mcp-sidecar"]
required = false
startup_timeout_sec = 5
```

Important setup note:

- Do **not** set `cwd` on this MCP server entry. Leaving `cwd` unset lets the
  sidecar inherit the real Codex project directory, which is how it matches the
  correct rollout session later.

If `claude-code-notify` is not resolvable from `PATH` in your Codex runtime,
use the full shim path instead:

```toml
[mcp_servers.claude_code_notify_sidecar]
command = "C:\\Users\\<you>\\AppData\\Roaming\\npm\\claude-code-notify.cmd"
args = ["codex-mcp-sidecar"]
required = false
startup_timeout_sec = 5
```

Practical notes:

- On session startup, the sidecar will hidden-launch `codex-session-watch` if
  that watcher is not already running.
- The sidecar helps approval localization only. It does **not** replace
  `codex-session-watch`, and it does not affect completion notifications.
- If the watcher cannot recover an exact session match from the sidecar record,
  the approval reminder still fires but may fall back to Toast-only behavior.

For implementation details and design trade-offs, see
[`DEVELOPMENT.md`](./DEVELOPMENT.md).

## Codex Session Watcher (Recommended For Approval Notifications)

Start a long-running watcher that tails local Codex rollout files under
`~/.codex/sessions` and the Codex TUI log under `~/.codex/log/codex-tui.log`.
This is the primary approval-watcher path for normal Codex CLI usage. It sends
a notification when Codex requests approval:

```bash
claude-code-notify codex-session-watch
```

If you configured `codex-mcp-sidecar`, you usually do **not** need to start
this manually. The first Codex session in the current Windows login will
auto-start it in the background.

If you want it to exist even before the first Codex session starts, or you are
not using the MCP sidecar, you can still enable Windows logon autostart once:

```bash
claude-code-notify autostart enable
```

Useful companion commands:

```bash
claude-code-notify autostart status
claude-code-notify autostart disable
```

Optional flags:

- `--sessions-dir <path>`: override the Codex sessions directory
- `--tui-log <path>`: override the Codex TUI log path
- `--poll-ms <ms>`: change the polling interval

You can also persist those watcher flags into autostart itself:

```bash
claude-code-notify autostart enable --poll-ms 2000
```

This mode tails local rollout files under `~/.codex/sessions` and the Codex TUI
log under `~/.codex/log/codex-tui.log`.

Practical notes:

- `codex-session-watch` is the main path for approval reminders, not completion
  notifications.
- Some very fast or already-approved escalation events may be suppressed to
  reduce false positives.
- For the detailed signal heuristics and suppression rules, see
  [`DEVELOPMENT.md`](./DEVELOPMENT.md).

> **Note:** by itself, session-watcher mode runs outside the original Codex
> terminal process, so it may have to fall back to Toast-only behavior. If you
> also configure `codex-mcp-sidecar`, the watcher can reuse exact terminal
> context for sessions whose sidecar resolved a matching `sessionId`. That same
> sidecar also auto-starts the watcher when a Codex session begins.

## Common Commands

```bash
claude-code-notify --help
claude-code-notify autostart enable
claude-code-notify autostart status
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

For protocol details and internal flow, see [`DEVELOPMENT.md`](./DEVELOPMENT.md).

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
