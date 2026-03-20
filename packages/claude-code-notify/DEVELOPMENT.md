# 开发说明

## 架构

```
Claude Hook (stdin JSON)
  → bin/cli.js
      ├─ 读 stdin → 提取 session_id、hook_event_name
      ├─ 建 log 文件：%TEMP%\claude-code-notify\session-<id>.log
      ├─ 显式 shell pid 覆盖（--shell-pid / TOAST_NOTIFY_SHELL_PID）
      ├─ detectTerminalContext()
      │    ├─ spawnSync scripts/find-hwnd.ps1 -IncludeShellPid
      │    │     └─ 返回 hwnd|shellPid|isWindowsTerminal
      │    ├─ 默认通过 get-shell-pid.ps1 从当前 console 自动探测交互 shell pid
      │    └─ 自动探测失败时，回退到 find-hwnd.ps1 父链识别出的 shell pid
      ├─ 若当前是 Windows Terminal：
      │    ├─ 先直接向当前 stdout/stderr 写 OSC 4;264 设色
      │    └─ spawnSync scripts/start-tab-color-watcher.ps1（stdio=ignore）
      │          ├─ Start-Process -NoNewWindow → tab-color-watcher.ps1
      │          └─ 通过临时 pid 文件把 watcher pid 回传给 cli.js
      │                ├─ AttachConsole(shellPid) → 打开 CONIN$/CONOUT$
      │                ├─ 再写一遍 OSC 4;264，补上异步 hook 场景的设色
      │                ├─ 等待“目标 console 自己有新输入 + 目标 WT 窗口回到前台”
      │                └─ 双通道写出 OSC 104;264 reset
      └─ spawn scripts/notify.ps1（通过环境变量传入 hwnd、event、log 路径）
            ├─ 用 TOAST_NOTIFY_HWND 发 toast
            └─ flash 任务栏
```

**为什么 hwnd 查找在 Node 侧（cli.js）而不是在 notify.ps1 里做：**
VSCode 集成 git bash 场景下，MSYS2 bash fork 会断开 PowerShell 自身的父进程链，
但 Node.exe 是纯 Win32 进程，其父链完整，因此在 Node 侧查找更可靠。

## Codex Session Watcher

```
Codex rollout JSONL (~/.codex/sessions/**/rollout-*.jsonl)
  → bin/cli.js codex-session-watch
      ├─ 周期扫描 rollout 文件
      ├─ 首次启动只读取 session_meta / turn_context 提取 sessionId、cwd，然后把 offset 定位到 EOF
      ├─ 后续按 offset 增量读取新增 JSONL 行
      ├─ 监听 rollout approval event_msg:
      │    ├─ exec_approval_request
      │    ├─ request_permissions
      │    └─ apply_patch_approval_request
      ├─ 监听 rollout response_item.function_call:
      │    └─ arguments.sandbox_permissions == require_escalated
      ├─ 同时增量扫描 ~/.codex/log/codex-tui.log
      │    └─ ToolCall: shell_command { ... sandbox_permissions=require_escalated ... }
      ├─ 不使用 op.dispatch.exec_approval / patch_approval
      │    └─ 因为那是“审批被处理”时刻，不是“审批弹窗出现”时刻
      ├─ 按 sessionId + approvalKind + turnId(+descriptor) 去重
      └─ 复用 notify.ps1 发 Toast
```

### 设计决策

**为什么用轮询扫描而不是 `fs.watch`？**

Codex 的 sessions 目录是按日期分层创建的，`rollout-*.jsonl` 会持续 append。轮询扫描更容易同时覆盖“新目录出现”“新文件出现”“现有文件继续写入”三类情况，行为也更可控。

**为什么首次启动默认从 EOF 开始？**

session watcher 目标是做“从现在开始”的后台提醒，而不是把历史会话整批重放成通知。首次启动时只抽取元数据（sessionId、cwd），不回放旧事件；之后只处理新增行。

**为什么不保留按 cwd 过滤？**

目标场景是“安装后用户继续直接用 `codex`，后台统一提醒”，而不是让普通用户理解 watcher 自己的工作目录或项目范围。固定全局监听更符合无感使用，也避免了 watcher 被错误地从某个目录启动后只盯住单个项目。

**为什么 session watcher 不尝试传入 HWND / shell pid？**

它是一个全局后台观察者，不在原始 Codex 终端的进程链里，无法可靠定位“真正触发事件的那个终端窗口”。如果错误地复用 watcher 自己的 HWND，只会把 `Open` / 闪烁指到错误窗口，因此该模式故意只发全局 Toast，不做窗口级定位。

**为什么不再从 TUI 的 `apply_patch` 日志推断 approval？**

这条启发式在真实 Codex 会话里被证伪过。`2026-03-20 17:24:56` 的一次误报里，`codex-tui.log` 确实出现了跨 workspace 的 `ToolCall: apply_patch *** Begin Patch`，但对应 rollout JSONL 里没有任何 approval event，`apply_patch` 也已经直接执行成功。也就是说，“patch 目标超出 cwd / writable_roots” 并不等价于“用户正在看到 approval 提示”。

因此当前实现只保留两类可靠信号：

- rollout JSONL 中真实出现的 `apply_patch_approval_request`
- TUI / rollout 里明确带有 `sandbox_permissions == require_escalated` 的 shell 工具调用

宁可少报，也不再接受这种 `Needs Approval` 误报。

## Codex App-Server Watcher

```
claude-code-notify codex-watch
  → 启动官方 `codex app-server`
      ├─ initialize / initialized
      ├─ thread/list（bootstrap 现有 thread，可选带 cwd 过滤）
      ├─ thread/started（缓存 thread 元数据）
      ├─ thread/status/changed
      └─ activeFlags 包含 waitingOnApproval → 复用 notify.ps1 发 Toast
```

### 设计决策

**为什么 `codex-watch` 不是当前推荐的 approval 主路径？**

`2026-03-18` 的端到端验证已经在 [`CODEX_APPROVAL_NOTIFICATION_SESSION_2026-03-18.md`](CODEX_APPROVAL_NOTIFICATION_SESSION_2026-03-18.md) 里记录：后台 watcher 自己拉起的 `codex app-server` 只能稳定观察到它自己那条连接里的 thread 状态，不能作为“其他 Codex 会话 approval 的全局观察者”。因此后来产品方向转为以 [`codex-session-watch`](README.md) 作为常规 approval 方案。

**为什么这个模式现在还保留？**

它对两类场景仍然有价值：

- 调试 / 研究官方 `app-server` 协议时，直接观察 `thread/status/changed` 与 `waitingOnApproval`
- 由本工具自己拥有 app-server 连接的窄场景，需要一个轻量的 app-server-scoped watcher

换句话说，它保留为“窄范围 / 高级模式”，不是面向普通 Codex CLI 使用者的默认 approval 入口。

**为什么要额外记录它的 `cwd` 边界？**

当前实现里，单 `cwd` 模式的过滤只显式出现在 [`thread/list` bootstrap](bin/cli.js) 请求上；后续实时 `thread/status/changed` 通知本身只带 `threadId` 和 `status`，不带 `cwd`。这意味着 watcher 只能依赖之前缓存到的 thread 元数据做归因；如果某个实时状态变化先于本地缓存到达，或者 thread 不在本地缓存里，就无法把“项目范围过滤”做成严格保证。

因此，这个模式应当被理解为：

- 对它自己那条 app-server 连接的状态观察是有效的
- 但它不是“严格按项目隔离、严格全局正确”的 approval 观察器
- 真正面向日常使用的 approval 主路径仍然是 `codex-session-watch`

## 图标合成

Toast 图标 = 底层 exe 图标 + 上层静态符号 PNG，由 [`scripts/notify.ps1`](scripts/notify.ps1) 在运行时叠加合成。合成结果缓存到包根目录的 `.cache/` 下。

### 设计决策

**为什么用图标而不是纯文字通知？**

图标能同时传达两个维度的信息（hook type + 终端来源），用户一眼即可识别，无需阅读文字；纯文字通知需要逐字解析，信息提取速度更慢。

**hook 符号层为什么静态预生成，而不是运行时绘制？**

符号（✓ / Q / i）与终端 exe 无关，内容固定。预生成为 PNG 随包分发，运行时只需 `DrawImage`，避免在 ps1 里维护大量 GDI+ path/pen 绘制代码（原动态方案约 100 行）。

**为什么还需要运行时合成，不直接用静态图标？**

通知图标的底层显示终端 exe 图标（VS Code、Windows Terminal 等），让用户一眼知道是哪个终端触发的。exe 图标因用户环境而异，无法预生成，必须运行时提取。若无法获取终端 exe 路径（如未传入 HWND），则直接显示静态符号图标，不做合成。

**缓存文件名为什么包含 exe slug？**

不同 app 可能先后触发同一 hook type（如 VS Code 和 Windows Terminal 都触发 Stop），底层图标不同，必须按 `{hookName}-{exeSlug}` 分别缓存，否则后写的会覆盖前者，导致图标错乱。

**为什么不需要关心缓存清理？**

缓存位于包根目录的 `.cache/` 内，不在 `files` 字段声明范围内，不会被打包分发。随 npm install 重建包目录时自动清空，无需额外处理，也不存在版本间的缓存兼容问题。

## 环境变量（cli.js → notify.ps1）

| 变量 | 说明 |
|------|------|
| `TOAST_NOTIFY_LOG_FILE` | log 文件完整路径（由 cli.js 计算并传入） |
| `TOAST_NOTIFY_EVENT` | hook 事件名（Stop / PermissionRequest） |
| `TOAST_NOTIFY_HWND` | 终端窗口句柄（找不到时不设置） |
| `TOAST_NOTIFY_IS_DEV` | 是否为开发版本（"1"=dev, "0"=生产） |
| `TOAST_NOTIFY_SOURCE` | 可显示的来源标签，非空时标题渲染为 `[source] title` |
| `TOAST_NOTIFY_TITLE` | 通知标题主体 |
| `TOAST_NOTIFY_MESSAGE` | 通知正文 |
| `TOAST_NOTIFY_SHELL_PID` | 显式指定当前交互 shell 的 PID（用于覆盖自动探测/父链回退结果） |

## dev/生产环境区分

通过 `.published` 文件区分：

- **本地开发**：无 `.published` 文件 → isDev=true → 通知标题显示 `[DEV]` 标记
- **已发布版本**：有 `.published` 文件 → isDev=false → 无标记

### `.published` 文件管理

- `prepublishOnly`（npm publish 时）：创建 `.published` 文件，写入版本号和日期
- `postpack`（打包完成后）：删除 `.published` 文件，本地保持干净

这样发布后本地自动恢复 dev 状态，无需手动清理。

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

### Tab 级定位 — Windows Terminal Tab 颜色指示器

**背景：** 通知只能激活到窗口级别，Windows Terminal 多 Tab 场景下无法识别哪个 Tab 需要关注。

**方案：** 通过 OSC `4;264`（WT 的 `FRAME_BACKGROUND` 私有扩展）改变目标 Tab 标签颜色。目标 shell PID 默认先从当前 console 的进程列表中自动探测，失败时回退到父进程链里识别出的 shell PID；`--shell-pid` / `TOAST_NOTIFY_SHELL_PID` 仅作为覆盖入口。提示会一直保留，直到 watcher 观察到目标 Tab 自己的 console 收到了新的输入、且对应的 WT 窗口重新成为前台；此时 watcher 通过附着后的 `CONOUT$` 和标准流双通道写出 `OSC 104;264`，不修改前台 shell 输入行，也不依赖 Windows Terminal action。

```
Claude Hook 触发 → cli.js
  ├─ --shell-pid / TOAST_NOTIFY_SHELL_PID → 显式覆盖目标 shellPid
  ├─ get-shell-pid.ps1 → 从当前 console 自动探测目标 shellPid
  ├─ find-hwnd.ps1 -IncludeShellPid → 返回 hwnd|shellPid|isWindowsTerminal（shellPid 作为自动探测失败时的回退）
  ├─ 直接向当前 hook 进程的 stdout/stderr 写 OSC 4;264 设色
  ├─ spawn notify.ps1（Toast + 闪烁，不变）
  └─ 通过 start-tab-color-watcher.ps1 用 Start-Process -NoNewWindow 拉起 tab-color-watcher.ps1
        ├─ Named Mutex 防重复：Global\claude-notify-tab-{shellPid}
        ├─ AttachConsole(shellPid) → 打开 CONIN$/CONOUT$，再写一遍 OSC 4;264 设色
        ├─ 记录 baselineForeground + baselineLastInputTick + baselineConsoleInputCount
        ├─ 轮询：WaitForMultipleObjects(processHandle, CONIN$) + GetForegroundWindow() + GetLastInputInfo()
        │     ├─ 目标 console 自己收到了新输入，且当前前台窗口 == TerminalHwnd → 双通道写出 OSC 104;264 reset，退出
        │     └─ 否则继续等待
        └─ processHandle 信号 → shell 退出，直接退出（无需重置）
```

**颜色方案（与通知图标一致）：**

| Hook 类型 | 颜色 | RGB |
|-----------|------|-----|
| Stop | 绿色 | `rgb:33/cc/33` |
| PermissionRequest | 橙色 | `rgb:ff/99/00` |
| default | 蓝色 | `rgb:33/99/ff` |

**关键设计决策：**

- **为什么用 Tab 颜色而不是其他手段：** Tab 标题需要阅读不够醒目；BEL 是一次性事件容易错过；OSC 9;4 进度指示器在 Tab 上无法区分颜色。OSC 4;264 让 Tab 标签整体变色，视觉区分度最高。
- **为什么 watcher 是独立进程：** hook 进程需要很快退出，但“用户什么时候回到该 Tab”可能发生在几十秒甚至几分钟后，因此必须把等待逻辑独立出去。
- **为什么 reset 用双通道输出：** 用户已验证，前台 shell 手工输出 `OSC 104;264` 可以恢复默认颜色；同时，hook 场景里单靠当前 hook 进程的 `stdout/stderr` 不一定还能命中目标 tab。因此 watcher 会先附着到目标 console，并在 reset 时同时尝试 `CONOUT$` 和标准流，两边谁有效就由谁完成恢复。
- **为什么恢复判定改成“目标 console 输入 + 前台返回”：** 仅看 `GetLastInputInfo()` 会把“同一 Windows Terminal 窗口里别的 tab 的输入”也算进去，导致 tab2 的操作把 tab1 的颜色清掉。现在必须先看到目标 console 自己的 `CONIN$` 收到新输入，再结合前台窗口判断，才允许 reset。
- **为什么 watcher 还要再设一次颜色：** 手工直接执行时，cli.js 直接往 stdout/stderr 写 OSC 往往已经足够；但 Claude 异步 hook 场景里，这两条流不一定还真正连着目标 tab。让 watcher 在 `AttachConsole` 成功后用 `CONOUT$` 再写一遍设色，可以把 hook 场景补回来。
- **为什么 shell pid 默认改成 console 级自动探测：** 设色阶段本来就发生在当前 Tab，对应 shell 也应当从“当前 console 有哪些进程”里拿，这比单纯沿父进程链猜测更贴近直接在 PowerShell/cmd Tab 里执行命令的真实场景。
- **为什么仍保留父链回退：** Claude hook 的异步启动链有时拿不到稳定的 console 进程列表，但父链方案在某些真实环境中已经被验证能工作。作为 fallback 更务实。
- **为什么还保留显式 shell pid 覆盖：** 调试、特殊 launcher 或极端环境下，调用方仍然可能比自动探测更清楚目标 shell 是谁，因此保留 `--shell-pid` / `TOAST_NOTIFY_SHELL_PID` 作为 override。
- **为什么通过 launcher 用 `Start-Process -NoNewWindow` 拉 watcher：** 最新实测日志里，Node 侧 `detached` child 已经返回了 PID，但对应 watcher 进程根本没有写出自己的 `started` 日志，说明那条启动链在当前机器上并没有真正把 watcher 跑起来。`Start-Process -NoNewWindow` 这条链此前已经被验证能稳定把 watcher 启起来，同时又不会打开新窗口，因此保留它。
- **为什么 launcher 改成“pid 文件回传 + stdio ignore”：** 早期让 launcher 通过 `stdout` 回传 watcher pid 时，watcher 会继承这些 pipe 句柄，导致 `cli.js` 的 `spawnSync(...)` 在手工执行 `claude-code-notify` 时一直挂住，看起来像“通知发完但命令不返回”。现在改成 launcher 把 watcher pid 写入临时文件，`cli.js` 读取后立刻删除，同时把 launcher 的 `stdio` 设为 `ignore`，这样 watcher 还能附着同一个 console，但不会再拖住前台命令退出。
- **为什么用户返回事件不限于按键：** 用户只要已经把注意力切回该 Tab，就应当视为提示已被看到。实现上优先接受 console 可观察到的用户返回信号，例如焦点恢复、按键、鼠标事件，而不是要求用户必须敲一次键。
- **为什么不做定时自动恢复：** 通知触发后，用户可能已经离开电脑一段时间。若用 5 秒、10 秒之类的定时器自动清掉颜色，用户回来时反而失去定位线索。当前设计要求提示一直保留，直到用户真的回到对应 Tab 并产生可识别的用户事件，再恢复默认颜色。
- **为什么当前不再区分 PowerShell / cmd / bash：** reset 不再通过前台 shell 执行命令，因此不需要为不同 shell 维护不同的 quoting 规则；只要目标 console 可附着，就可以直接往输出通道写恢复序列。
- **为什么用 Named Mutex 防重复：** 同一 Tab 短时间多次通知不应累积多个 watcher，OS 级 mutex 比 PID 文件更可靠，进程退出自动释放。

**限制：** 仅限 Windows Terminal（OSC 4;264 是 WT 私有扩展），非 WT 环境不 spawn watcher，原有功能不受影响。

**实现文件：** [`get-shell-pid.ps1`](scripts/get-shell-pid.ps1)（当前 console shell 自动探测）、[`find-hwnd.ps1`](scripts/find-hwnd.ps1)（窗口检测）、[`start-tab-color-watcher.ps1`](scripts/start-tab-color-watcher.ps1)（watcher launcher + pid 文件回传）、[`tab-color-watcher.ps1`](scripts/tab-color-watcher.ps1)（watcher 主体）、[`cli.js`](bin/cli.js)（集成调度）
