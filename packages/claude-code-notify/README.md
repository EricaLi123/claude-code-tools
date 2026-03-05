# claude-code-notify

Windows Toast notifications for Claude Code.

Get notified when Claude finishes a task or needs your permission.

## Features

- **Toast notification** — popup when Claude is done or waiting for approval
- **Taskbar flash** — flashes the terminal window until you switch to it
- **Click to activate** — click "Open" on the notification to jump to the terminal (Windows 11)
- Auto-detects terminal name and project name

## Quick Start

```bash
npx claude-code-notify setup
```

This will:
1. Copy scripts to `%USERPROFILE%\.claude\scripts\claude-notify\`
2. Install the [BurntToast](https://github.com/Windos/BurntToast) PowerShell module
3. Register the click-to-activate protocol handler
4. Configure hooks in `settings.json` (won't overwrite existing hooks)

Restart Claude Code after setup.

## How It Works

After setup, your Claude Code hooks config will look like:

```json
{
    "hooks": {
        "Stop": [{ "hooks": [{ "type": "command", "command": "cmd /c npx -y claude-code-notify@latest", "async": true }] }],
        "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "cmd /c npx -y claude-code-notify@latest", "async": true }] }]
    }
}
```

Every time Claude stops or requests permission, it runs `npx claude-code-notify@latest`, which always pulls the latest version automatically.

## Notification Format

```
Title:   Claude Done (WindowsTerminal)
Body:    Task finished
         my-project
```

## Requirements

- Windows 10 / 11
- Node.js >= 16
- PowerShell 5.1+

## Known Limitations

- **Windows 10**: Toast notifications and taskbar flash work. Click-to-activate ("Open" button) does not work due to OS limitations on non-packaged desktop apps.
- **Windows 11**: All features work.
- **macOS / Linux**: Not yet supported.

## License

MIT
