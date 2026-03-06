# claude-code-notify

Windows Toast notifications for Claude Code.

Get notified when Claude finishes a task or needs your permission.

## Features

- **Toast notification** — native WinRT toast, no BurntToast or other modules needed
- **Taskbar flash** — flashes the terminal window until you switch to it
- **Click to activate** — click "Open" on the toast to jump back to the terminal
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

The click-to-activate protocol is registered automatically on install.

## Notification Example

```
Title:   Claude Done (WindowsTerminal)
Body:    Task finished
         my-project
Button:  [Open]
```

## How It Works

1. Reads hook event JSON from stdin
2. Walks the process tree (single WMI query) to find the terminal window
3. Sends a native WinRT toast notification (using PowerShell's registered AppUserModelId)
4. Flashes the terminal taskbar button

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
