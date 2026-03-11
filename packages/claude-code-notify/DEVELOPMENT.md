# 开发说明

## 架构

```
Claude Hook (stdin JSON)
  → bin/cli.js
      ├─ 读 stdin → 提取 session_id、hook_event_name
      ├─ 建 log 文件：%TEMP%\claude-code-notify\session-<id>.log
      ├─ spawnSync scripts/find-hwnd.ps1（从 Node PID 向上找有窗口的祖先进程）
      │     └─ 返回 hwnd（或 0）
      └─ spawn scripts/notify.ps1（通过环境变量传入 hwnd、event、log 路径）
            ├─ 用 CLAUDE_NOTIFY_HWND 发 toast
            └─ flash 任务栏
```

**为什么 hwnd 查找在 Node 侧（cli.js）而不是在 notify.ps1 里做：**
VSCode 集成 git bash 场景下，MSYS2 bash fork 会断开 PowerShell 自身的父进程链，
但 Node.exe 是纯 Win32 进程，其父链完整，因此在 Node 侧查找更可靠。

## 环境变量（cli.js → notify.ps1）

| 变量 | 说明 |
|------|------|
| `CLAUDE_NOTIFY_LOG_FILE` | log 文件完整路径 |
| `CLAUDE_NOTIFY_EVENT` | hook 事件名（Stop / PermissionRequest） |
| `CLAUDE_NOTIFY_SESSION_ID` | 会话 ID |
| `CLAUDE_NOTIFY_HWND` | 终端窗口句柄（找不到时不设置） |

## 已知问题及解决方案

### VSCode/Cursor 集成 git bash — 窗口检测

**现象：** toast 标题显示 `(Terminal)`，任务栏无闪烁。

**根本原因：** MSYS2 bash fork 导致 Windows 父进程链在 bash 边界断开，
从 Node 进程向上走，depth=12 时遇到已退出进程，链断，走不到 `Code.exe`。

**否决的方案：**

- ❌ 进程名匹配（搜索所有 `Code.exe` / `Cursor.exe`）— 多窗口时会选错，不可靠
- ❌ `VSCODE_PID` 环境变量 — VSCode 集成 git bash 场景下实测不注入此变量

**最终方案：** `VSCODE_GIT_IPC_HANDLE` 命名管道

VSCode 在所有集成终端中注入 `VSCODE_GIT_IPC_HANDLE`（named pipe 路径）。
用 Win32 API `GetNamedPipeServerProcessId` 获取该 pipe 的服务端 PID（即当前
VSCode 实例的 extension host），再向上一步即到主窗口。

```
VSCODE_GIT_IPC_HANDLE=\\.\pipe\vscode-git-ec9a16cdec-sock
  → GetNamedPipeServerProcessId → pid=25792（Code.exe extensionHost，hwnd=0）
  → parent → pid=19056（Code.exe 主窗口，hwnd=394950）✓
```

实现位置：`scripts/find-hwnd.ps1` 主链断后的 fallback 块。

### Toast "Open" 按钮 — 终端窗口闪烁

**现象：** 点击 Toast 的 "Open" 按钮时，会短暂闪现一个终端窗口。

**根本原因：** 使用 `powershell.exe -EncodedCommand` 或 `-WindowStyle Hidden` 启动时，
PowerShell 在窗口样式生效前仍会短暂显示窗口，即使指定隐藏参数也无法完全避免。

**尝试的方案：**

- ❌ `-EncodedCommand` 内联脚本 — 仍有闪烁
- ❌ `-File` 参数调用脚本 — 仍有闪烁

**最终方案：** VBScript wrapper

使用 `wscript.exe`（GUI 版本脚本宿主）调用 VBScript，再由 VBScript 调用 PowerShell。
VBScript 的 `shell.Run command, 0, False` 中 `0` 参数可完全隐藏窗口，且 wscript 本身不显示控制台。

```
协议注册命令：wscript.exe activate-window.vbs "%1"
  → VBScript: shell.Run "powershell.exe ... -File activate-window.ps1", 0, False
      → activate-window.ps1 实际执行窗口激活
```

实现位置：`scripts/activate-window.vbs`、`scripts/register-protocol.ps1`

### Toast 激活机制与 Windows 打包限制

**背景：** Windows Toast 支持三种激活类型：

| 类型 | 要求 | 行为 |
|------|------|------|
| `protocol` | 只需注册表 | 启动关联的 protocol handler |
| `foreground` | 需要 MSIX 打包 + COM Activator | 前台激活应用主窗口 |
| `background` | 需要 MSIX 打包 + COM Activator | 后台处理 |

**限制来源：** [Microsoft 文档](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/toast-desktop-apps)：

> 未打包的桌面应用只能使用 protocol activation，因为 stub CLSID 会破坏其他类型的激活。

**当前项目的选择：**

作为 npm 包，要求用户安装 MSIX 不现实，因此使用 protocol activation：

```xml
<action activationType="protocol"
        arguments="erica-s.claude-code-notify.activate-window://<hwnd>"
        content="Open"/>
```

**已知问题：**

1. **焦点行为不可靠** — protocol handler 启动的进程可能在后台运行，不会自动获得焦点
2. **Windows 10 vs 11** — 两者打包要求相同，但实际行为可能因版本而异（Win11 表现通常更好）
3. **`SetForegroundWindow` 限制** — Windows 防止焦点窃取，可能导致窗口激活失败

**缓解措施：**

- VBScript wrapper 避免窗口闪烁
- `SetForegroundWindow` + `ShowWindow(hwnd, 9)` (SW_RESTORE) 组合尝试激活
- 如需更可靠的前台激活，需要 MSIX 打包 + COM Activator（但部署成本高）
