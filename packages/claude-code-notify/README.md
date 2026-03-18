# claude-code-notify

Windows Toast notifications for Claude Code.

Get notified when Claude finishes a task or needs your permission.

This package now also supports a Codex watcher mode that listens for
`waitingOnApproval` through the official `codex app-server`.

## 解决什么问题

Claude Code 会话可能长时间运行，用户切到其他窗口后无法感知状态变化。本工具解决两个核心问题：

### 1. 提醒 — 让用户知道某个会话需要关注

- 系统原生 Toast 通知
- 任务栏闪烁

### 2. 定位 — 帮助用户找到并回到该会话

- 通知内容包含终端类型、项目名等上下文，便于识别
- 闪烁对应的终端窗口，视觉引导
- 通知提供 "Open" 按钮，点击直接激活目标窗口

## Features

- **Toast notification** — native WinRT toast, no BurntToast or other modules needed
- **Taskbar flash** — flashes the terminal window until you switch to it
- **Click to activate** — click "Open" on the toast to jump back to the terminal
- **Automatic shell PID detection for tab color** — targets the current terminal shell without requiring manual PID arguments
- **Automatic Windows Terminal tab color reset** — keeps the highlight until you come back, then clears it without touching the foreground shell input
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
> **Override:** `--shell-pid <pid>` and `CLAUDE_NOTIFY_SHELL_PID` are still supported for debugging or special launchers, but normal usage no longer requires them. Shell detection now prefers current-console detection and falls back to the parent-process shell chain when needed.

The click-to-activate protocol is registered automatically on install.

## Codex Watcher

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

Under the hood this mode:

1. Starts the official `codex app-server`
2. Sends `initialize`
3. Bootstraps existing threads with `thread/list`
4. Watches `thread/status/changed`
5. Triggers the existing Windows toast flow when `activeFlags` contains `waitingOnApproval`

## Notification Example

**生产版本：**
```
Title:   Claude Done (Windows Terminal)
Body:    Task finished
         my-project
Button:  [Open]
```

**开发版本（本地 npm link）：**
```
Title:   [DEV] Claude Done (Windows Terminal)
Body:    Task finished
         my-project
Button:  [Open]
```

## How It Works

1. Reads hook event JSON from stdin
2. Walks the process tree (ToolHelp32 snapshot) to find the terminal window
3. Detects the current console shell PID for Windows Terminal tab tracking
4. Writes a WT tab-color OSC immediately, then spawns a watcher for the target console
5. Sends a native WinRT toast notification (using PowerShell's registered AppUserModelId)
6. Flashes the terminal taskbar button

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
