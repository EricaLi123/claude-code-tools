# Windows 运行时与通知实现

这一页记录 Windows 平台上的运行时约束、兼容性问题和当前采用方案。若改动会弱化定位能力或默认路线，先回到 [`principles.md`](./principles.md)。带日期的演进过程统一放到 [`history/`](./history/)。

## 要解决的问题

- Windows 下要兼顾 notify payload 传递、命令启动方式、窗口定位和激活限制。
- 包的对外入口要尽量稳定，同时兼顾 payload 传递和额外 watcher 带来的兼容性约束。
- 在 Windows Terminal 场景下，窗口级提醒还不够，需要尽量补到 tab 级指示。

## 当前结论

- `hwnd` / `shellPid` 的定位放在 Node 侧完成，再把结果通过环境变量传给 `notify.ps1`。
- Windows direct process launch 的命令约定和 payload 约束统一放在这里，不再混在总入口文档里。
- Windows Terminal tab watcher 只在 WT 环境下启用；非 WT 环境只保留现有 toast / flash / open 行为。
- 带机器环境前提的 tab 颜色演进过程单独归档，不和当前实现细节混排。

## 当前约定

### Payload 约束

Codex legacy notify 会把 payload 作为最后一个 JSON argv 追加给命令。当前 runtime 约定是：

- `normalizeIncomingNotification()` 负责统一收口 Claude 的 stdin JSON 和 Codex 的 argv JSON
- 公开默认入口仍然是 `ai-agent-notify.cmd`
- 超长 session 仍可能放大 Windows argv 风险；这和命令解析是两个独立问题

相关历史和机器实测见 [`history/codex-completion-findings.md`](./history/codex-completion-findings.md)。

### Windows 命令名约定

Windows 上如果配置项是“直接起进程”，当前约定是显式写 `.cmd`：

- 全局安装路线写 `ai-agent-notify.cmd`
- `npx` 路线写 `npx.cmd`

不要依赖不带后缀的命令名：

- `cmd.exe` / PowerShell 这类 shell 往往会按 `PATHEXT` 帮你补全到 `.cmd`
- 但 `notify = [...]`、MCP `command = "..."` 这类 direct process launch 不一定经过 shell
- 在这类调用里，`ai-agent-notify` 可能不会自动补到 `ai-agent-notify.cmd`

当前这个包在 Volta 全局安装场景下也符合这个规律：

- `ai-agent-notify` 是 bash shim
- `ai-agent-notify.cmd` 才是 Windows cmd shim

因此当前 Windows 文档里，只要是在 direct process launch 语境，就显式写 `.cmd`。

## 关键问题与采用方案

### 图标合成

Toast 图标 = 底层 exe 图标 + 上层静态符号 PNG，由 [`scripts/notify.ps1`](../scripts/notify.ps1) 在运行时叠加合成。合成结果缓存到包根目录的 `.cache/` 下。

#### 为什么这样做

**为什么用图标而不是纯文字通知？**

图标能同时传达 hook type 和终端来源两个维度，用户一眼即可识别，无需阅读文字。

**hook 符号层为什么静态预生成，而不是运行时绘制？**

符号（✓ / Q / i）与终端 exe 无关，内容固定。预生成 PNG 随包分发，运行时只需 `DrawImage`，避免在 PowerShell 里维护大量 GDI+ 绘制代码。

**为什么还需要运行时合成，不直接用静态图标？**

通知图标的底层显示终端 exe 图标（VS Code、Windows Terminal 等），让用户一眼知道是哪个终端触发的。exe 图标因用户环境而异，无法预生成。

**缓存文件名为什么包含 exe slug？**

不同 app 可能先后触发同一图标类型，底层图标不同，必须按 `{iconKey}-{exeSlug}` 分别缓存，否则后写的会覆盖前者。

**为什么不需要关心缓存清理？**

缓存位于包根目录的 `.cache/` 内，不在 `files` 字段声明范围内，不会被打包分发。随 npm install 重建包目录时自动清空，无需额外处理。

### VSCode/Cursor 集成 git bash — 窗口检测

**现象：** toast 标题显示 `(Terminal)`，任务栏无闪烁。

**根本原因：** MSYS2 bash fork 导致 Windows 父进程链在 bash 边界断开，从 Node 进程向上走时可能在中途遇到已退出进程。

**否决的方案：**

- 进程名匹配（搜索所有 `Code.exe` / `Cursor.exe`）: 多窗口时会选错，不可靠
- `VSCODE_PID` 环境变量: VSCode 集成 git bash 场景下不稳定

**采用方案：** `VSCODE_GIT_IPC_HANDLE` 命名管道。通过 Win32 API `GetNamedPipeServerProcessId` 获取 pipe 服务端 PID，再向上一层定位到主窗口。

### Toast "Open" 按钮 — 终端窗口闪烁

**现象：** 点击 Toast 的 `Open` 按钮时，会短暂闪现一个终端窗口。

**根本原因：** 使用 `powershell.exe -EncodedCommand` 或 `-WindowStyle Hidden` 启动时，PowerShell 在窗口样式生效前仍可能短暂显示窗口。

**采用方案：** VBScript wrapper。由 `wscript.exe` 调用 VBScript，再由 VBScript 调用 PowerShell，利用 `shell.Run command, 0, False` 完全隐藏控制台。

### Toast 激活机制与 Windows 打包限制

Windows Toast 支持 `protocol`、`foreground`、`background` 三类激活，但未打包的桌面应用只能稳定使用 protocol activation。当前作为 npm 包分发，因此采用 protocol activation：

```xml
<action activationType="protocol"
        arguments="erica-s.ai-agent-notify.activate-window://<hwnd>"
        content="Open"/>
```

当前仍成立的限制：

- protocol handler 启动的进程可能在后台运行，不会自动获得焦点
- Windows 10 / 11 的实际表现可能有差异
- `SetForegroundWindow` 受 Windows 防焦点窃取策略限制

### Tab 级定位 — Windows Terminal Tab 颜色指示器

**背景：** 通知只能激活到窗口级别，Windows Terminal 多 Tab 场景下无法识别哪个 Tab 需要关注。

**方案：** 通过 OSC `4;264`（WT 的 `FRAME_BACKGROUND` 私有扩展）改变目标 Tab 标签颜色。目标 shell PID 默认先从当前 console 的进程列表中自动探测，失败时回退到父进程链里识别出的 shell PID；`--shell-pid` / `TOAST_NOTIFY_SHELL_PID` 仅作为覆盖入口。提示会一直保留，直到 watcher 观察到目标 Tab 自己的 console 收到了新的输入、且对应的 WT 窗口重新成为前台；此时 watcher 通过附着后的 `CONOUT$` 和标准流双通道写出 `OSC 104;264`。

```text
Hook 触发 → cli.js
  ├─ --shell-pid / TOAST_NOTIFY_SHELL_PID
  ├─ get-shell-pid.ps1
  ├─ find-hwnd.ps1 -IncludeShellPid
  ├─ 直接向当前 stdout/stderr 写 OSC 4;264
  ├─ spawn notify.ps1
  └─ start-tab-color-watcher.ps1
        ├─ Named Mutex 防重复
        ├─ AttachConsole(shellPid) → 再写一遍 OSC 4;264
        ├─ 观察 CONIN$ + 前台窗口
        └─ 满足条件后双通道写出 OSC 104;264 reset
```

**颜色方案（与通知图标一致）：**

| Hook 类型 | 颜色 | RGB |
| --- | --- | --- |
| Stop | 绿色 | `rgb:33/cc/33` |
| PermissionRequest | 橙色 | `rgb:ff/99/00` |
| default | 蓝色 | `rgb:33/99/ff` |

**为什么这样做：**

- 为什么用 Tab 颜色而不是其他手段：视觉区分度最高，不要求用户阅读标题或依赖一次性事件
- 为什么 watcher 是独立进程：hook 进程需要快速退出，但“用户什么时候回到该 Tab”可能发生在几十秒甚至几分钟后
- 为什么 reset 用双通道输出：当前 hook 进程的 `stdout/stderr` 在异步场景里不一定仍然连着目标 tab
- 为什么恢复判定改成“目标 console 输入 + 前台返回”：避免同一 WT 窗口中其他 tab 的输入误清颜色
- 为什么仍保留父链回退和显式 shell pid 覆盖：不同 launcher / hook 链路下，console 自动探测并非总能稳定命中

**限制：** 仅限 Windows Terminal；非 WT 环境不启动 tab watcher，原有功能不受影响。

**实现文件：**

- [`../scripts/get-shell-pid.ps1`](../scripts/get-shell-pid.ps1)
- [`../scripts/find-hwnd.ps1`](../scripts/find-hwnd.ps1)
- [`../scripts/start-tab-color-watcher.ps1`](../scripts/start-tab-color-watcher.ps1)
- [`../scripts/tab-color-watcher.ps1`](../scripts/tab-color-watcher.ps1)
- [`../bin/cli.js`](../bin/cli.js)

## 环境变量（cli.js → notify.ps1）

| 变量 | 说明 |
| --- | --- |
| `TOAST_NOTIFY_LOG_FILE` | log 文件完整路径（由 cli.js 计算并传入） |
| `TOAST_NOTIFY_EVENT` | hook 事件名（Stop / PermissionRequest） |
| `TOAST_NOTIFY_HWND` | 终端窗口句柄（找不到时不设置） |
| `TOAST_NOTIFY_IS_DEV` | 是否为开发版本（`1` = dev，`0` = 生产） |
| `TOAST_NOTIFY_SOURCE` | 可显示的来源标签，非空时标题渲染为 `[source] title` |
| `TOAST_NOTIFY_TITLE` | 通知标题主体 |
| `TOAST_NOTIFY_MESSAGE` | 通知正文 |
| `TOAST_NOTIFY_SHELL_PID` | 显式指定当前交互 shell 的 PID（用于覆盖自动探测 / 父链回退结果） |

## dev/生产环境区分

通过 `.published` 文件区分：

- 本地开发：无 `.published` 文件 -> `isDev = true` -> 通知标题显示 `[DEV]`
- 已发布版本：有 `.published` 文件 -> `isDev = false` -> 不加开发标记

### `.published` 文件管理

- `prepublishOnly`：创建 `.published` 文件，写入版本号和日期
- `postpack`：删除 `.published` 文件，本地保持干净

这样发布后本地自动恢复 dev 状态，无需手动清理。

## 当前仍成立的限制

- `SetForegroundWindow` 受 Windows 防焦点窃取策略限制。
- Windows 10 / 11 的 toast 激活实际表现可能不同。
- Windows Terminal tab watcher 只覆盖 WT；其他终端只能做到窗口级或 toast 级提醒。

## 相关历史

- [文档总览](./README.md)
- [开发原则](./principles.md)
- [Windows Terminal Tab 颜色演进](./history/tab-color-history.md)
- [Codex completion 实测结论](./history/codex-completion-findings.md)
