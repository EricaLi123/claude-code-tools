# claude-code-notify

Windows Toast notifications for Claude Code and Codex.

Get notified when Claude or Codex finishes a task, or when a watcher sees an
approval request.

This package now also supports Codex integration modes for:

- handling Codex direct `notify` payloads passed as a JSON argv argument for completion notifications
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

## Usage

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

## Codex Direct Notify

Codex `notify` executes a program directly and appends a JSON payload as the
final argv argument. This package now understands that payload shape in its
default mode, so you can point Codex at `claude-code-notify` directly:

```toml
notify = ["claude-code-notify"]
```

Current Codex direct-notify payloads use a shape like:

```json
{
  "type": "agent-turn-complete",
  "thread-id": "12345",
  "turn-id": "67890",
  "cwd": "D:\\XAGIT\\claude-code-tools",
  "client": "codex-tui",
  "input-messages": ["Rename foo to bar"],
  "last-assistant-message": "Rename complete."
}
```

Important limitation: Codex's current legacy `notify` hook only emits the
`after_agent` payload shape above. It cannot signal approval requests. If you
want approval notifications from normal Codex CLI usage, use
`codex-session-watch`. `codex-watch` is a narrower app-server-scoped mode and
should not be treated as the default global approval watcher.

If your Codex runtime cannot resolve `claude-code-notify` from `PATH`, point
`notify` to the full `.cmd` shim path or a wrapper script instead.

## Codex Session Watcher (Recommended For Approval Notifications)

Start a long-running watcher that tails local Codex rollout files under
`~/.codex/sessions` and the Codex TUI log under `~/.codex/log/codex-tui.log`.
This is the primary approval-watcher path for normal Codex CLI usage. It sends
a notification when Codex requests approval:

```bash
claude-code-notify codex-session-watch
```

Optional flags:

- `--sessions-dir <path>`: override the Codex sessions directory
- `--tui-log <path>`: override the Codex TUI log path
- `--poll-ms <ms>`: change the polling interval

This mode watches these local Codex signals:

- rollout approval events when present:
  - `exec_approval_request`
  - `request_permissions`
  - `apply_patch_approval_request`
- rollout tool calls that request sandbox escalation:
  - `response_item` with `type == "function_call"`
  - function-call arguments contain `"sandbox_permissions":"require_escalated"`
- TUI early approval signals:
  - `ToolCall: shell_command { ... "sandbox_permissions":"require_escalated" ... }`

It intentionally does not rely on `op.dispatch.exec_approval` or
`op.dispatch.patch_approval`, because those lines appear when the approval is
handled, not when the approval prompt first appears.

It also intentionally does not infer approval from `ToolCall: apply_patch`
lines in `codex-tui.log`. Real Codex sessions can emit cross-workspace
`apply_patch` tool calls that execute successfully without any user approval
prompt, and that heuristic caused false positive `Needs Approval` toasts.

> **Note:** session-watcher mode runs outside the original Codex terminal
> process, so it can show Toast notifications, but it cannot reliably flash
> or reopen the exact source terminal window.

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

Under the hood this mode:

1. Starts the official `codex app-server`
2. Sends `initialize`
3. Bootstraps existing threads with `thread/list`
4. Watches `thread/status/changed`
5. Triggers the existing Windows toast flow when `activeFlags` contains `waitingOnApproval`

## Notification Example

**生产版本：**
```
Title:   [Claude] Done (Windows Terminal)
Body:    Task finished
Button:  [Open]
```

**开发版本（本地 npm link）：**
```
Title:   [DEV] [Claude] Done (Windows Terminal)
Body:    Task finished
Button:  [Open]
```

## How It Works

1. Reads notification payload JSON from stdin or argv
2. Walks the process tree (ToolHelp32 snapshot) to find the terminal window
3. Detects the current console shell PID for Windows Terminal tab tracking
4. Writes a WT tab-color OSC immediately in the current process
5. Starts a background watcher that attaches to the target console, re-applies color for async-hook cases, and later resets it only after that tab returns to foreground and produces new console input
6. Sends a native WinRT toast notification (using PowerShell's registered AppUserModelId)
7. Flashes the terminal taskbar button

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
