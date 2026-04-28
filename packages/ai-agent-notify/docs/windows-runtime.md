# Windows 运行时与通知实现

这一页记录 Windows 平台上的运行时约束和当前实现约定。若改动会弱化定位能力、改变命令入口规则或影响 WT tab 提示，先回到 [`principles.md`](./principles.md)。带日期的演进过程统一放到 [`history/`](./history/)。

## 这页不负责什么

- 不负责定义 approval 默认路线、signal 优先级和 fallback 语义，那是 [`codex-approval.md`](./codex-approval.md)。
- 不负责定义总体产品目标和长期职责拆分，那是 [`architecture.md`](./architecture.md)。
- 不负责保存带日期的机器差异和试错过程，那是 [`history/`](./history/)。

## 先看结论

- `hwnd` / `shellPid` 的定位放在 Node 侧完成，再把结果通过环境变量传给 `notify.ps1`。
- Windows direct process launch 语境下显式写 `.cmd`；不要依赖 shell 自动补全。
- Windows Terminal tab watcher 只在 WT 环境下启用；非 WT 环境只保留 toast / flash / open。
- 带机器环境前提的 tab 颜色演进不在这里展开，单独归档到 [`history/tab-color-history.md`](./history/tab-color-history.md)。

## 如果你要改 Windows 行为，先判断改的是哪类问题

| 你要改的东西 | 当前 owner / 入口 |
| --- | --- |
| payload 收口 | `normalizeIncomingNotification()` |
| 命令入口 / `.cmd` 规则 | 当前文档的“命令名约定” |
| 窗口定位 / `hwnd` / `shellPid` | `cli.js` + `find-hwnd.ps1` + `get-shell-pid.ps1` |
| 图标合成 | `notify.ps1` |
| 任务栏闪烁 | `notify.ps1` |
| WT tab 设色 / reset | `start-tab-color-watcher.ps1` + `tab-color-watcher.ps1` |

## Runtime 约定

### 归一化字段约定

对 runtime 上游传下来的归一化事件，当前文档约定如下：

- `agentId` 只表示 agent 来源，只应取 `claude`、`codex`、`unknown`。
- `entryPointId` 只表示本包内部入口，例如 `notify-mode`、`hooks-mode`、`rollout-watch`、`tui-watch`。
- 面向用户的显示标签只由 `agentId + entryPointId` 组合出来，但这不是新的规范字段。
- `source` 已从规范字段删除；Windows runtime 只透传 `TOAST_NOTIFY_AGENT_ID` 和 `TOAST_NOTIFY_ENTRY_POINT`。

### Payload 约束

Codex legacy notify 会把 payload 作为最后一个 JSON argv 追加给命令。当前 runtime 约定是：

- `normalizeIncomingNotification()` 统一收口 Claude 的 stdin JSON 和 Codex 的 argv JSON
- 默认公开入口仍然是 `ai-agent-notify.cmd`
- 超长 session 仍可能放大 Windows argv 风险；这和命令解析是两个独立问题

相关历史和机器实测见 [`history/codex-completion-findings.md`](./history/codex-completion-findings.md)。

### Windows 命令名约定

Windows 上如果配置项是“直接起进程”，当前约定是显式写 `.cmd`：

- 全局安装路线写 `ai-agent-notify.cmd`
- `npx` 路线写 `npx.cmd`

不要依赖不带后缀的命令名：

- `cmd.exe` / PowerShell 往往会按 `PATHEXT` 自动补全
- 但 `notify = [...]`、MCP `command = "..."` 这类 direct process launch 不一定经过 shell
- 在这类调用里，`ai-agent-notify` 可能不会自动补到 `ai-agent-notify.cmd`

当前包在 Volta 全局安装场景下也符合这个规律：

- `ai-agent-notify` 是 bash shim
- `ai-agent-notify.cmd` 才是 Windows cmd shim

## 核心代码入口

| 主题 | 主要文件 |
| --- | --- |
| CLI 到 runtime 的通知入口 | [`../bin/cli.js`](../bin/cli.js) |
| runtime 日志、build identity、通知派发 | [`../lib/notify-runtime.js`](../lib/notify-runtime.js) |
| 终端 / 父链 / hwnd / shellPid 探测 | [`../lib/notify-terminal-context.js`](../lib/notify-terminal-context.js) |
| PowerShell 通知实现 | [`../scripts/notify.ps1`](../scripts/notify.ps1) |
| hwnd 探测脚本 | [`../scripts/find-hwnd.ps1`](../scripts/find-hwnd.ps1) |
| shell pid 探测脚本 | [`../scripts/get-shell-pid.ps1`](../scripts/get-shell-pid.ps1) |
| WT watcher launcher | [`../scripts/start-tab-color-watcher.ps1`](../scripts/start-tab-color-watcher.ps1) |
| WT watcher 主脚本 | [`../scripts/tab-color-watcher.ps1`](../scripts/tab-color-watcher.ps1) |

## 具体实现约定

### 图标合成

Toast 图标 = 底层 exe 图标 + 上层静态符号 PNG，由 [`../scripts/notify.ps1`](../scripts/notify.ps1) 在运行时叠加合成。结果缓存到包根目录 `.cache/`。

这里保留的关键结论只有四个：

- 用图标而不是纯文字，是为了同时传达 hook type 和终端来源
- 符号层静态预生成，避免在 PowerShell 里维护大量绘制代码
- 底层 exe 图标必须运行时获取，因为用户环境各不相同
- 缓存按 `{iconKey}-{exeSlug}` 区分，避免不同终端互相覆盖

### VSCode/Cursor 集成 git bash 的窗口检测

典型现象是 toast 标题显示 `(Terminal)` 且任务栏不闪烁。

当前采用的判断是：

- 不靠简单进程名匹配
- 不依赖 `VSCODE_PID`
- 通过 `VSCODE_GIT_IPC_HANDLE` 命名管道，借助 Win32 API `GetNamedPipeServerProcessId` 找到 pipe 服务端 PID，再向上一层定位主窗口

根本原因是 MSYS2 bash fork 会把 Windows 父进程链切断，导致“从 bash 往上找窗口”不稳定。

### 任务栏闪烁

如果 `cli.js` 成功定位到 `TOAST_NOTIFY_HWND`，`notify.ps1` 还会调用 `FlashWindowEx` 闪烁目标窗口任务栏按钮。

这条信号只负责“告诉用户哪个窗口需要看”；Windows 10 / 11 的实际表现可能有差异。

### Windows Terminal Tab 颜色提示

通知只能激活到窗口级别；在 WT 多 Tab 场景下，窗口级信息不够，所以当前补了一层 tab 颜色提示。

方案核心：

- 通过 OSC `4;264` 改变目标 Tab 的 `FRAME_BACKGROUND`
- shell PID 默认先从当前 console 自动探测，失败时回退到父进程链识别出的 shell PID
- `--shell-pid` / `TOAST_NOTIFY_SHELL_PID` 只作为覆盖入口
- reset 条件不是“窗口回来就清”，而是“目标 WT 窗口重新成为前台 + 目标 console 自己收到新输入”

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

颜色方案：

| Hook 类型 | 颜色 | RGB |
| --- | --- | --- |
| Stop | 绿色 | `rgb:33/cc/33` |
| PermissionRequest | 橙色 | `rgb:ff/99/00` |
| InputRequest | 橙色 | `rgb:ff/99/00` |
| default | 蓝色 | `rgb:33/99/ff` |

保留这套设计的原因：

- Tab 颜色比标题或一次性前台事件更容易定位
- watcher 必须是独立进程，因为“用户何时回到该 Tab”可能发生在几分钟后
- reset 走双通道输出，因为 hook 进程的 `stdout/stderr` 在异步场景下不一定还连着目标 tab
- 恢复判定必须看“目标 console 输入 + 前台返回”，否则同一 WT 窗口中其他 tab 的输入会误清颜色

仅限 Windows Terminal；非 WT 环境不启动 tab watcher。

## 环境变量（cli.js → notify.ps1）

| 变量 | 说明 |
| --- | --- |
| `TOAST_NOTIFY_LOG_FILE` | log 文件完整路径 |
| `TOAST_NOTIFY_EVENT` | hook 事件名（Stop / PermissionRequest / InputRequest） |
| `TOAST_NOTIFY_HWND` | 终端窗口句柄（找不到时不设置） |
| `TOAST_NOTIFY_IS_DEV` | 是否为开发版本（`1` = dev，`0` = 生产） |
| `TOAST_NOTIFY_AGENT_ID` | agent 来源 id |
| `TOAST_NOTIFY_ENTRY_POINT` | 代码入口 id，例如 `notify-mode` / `hooks-mode` |
| `TOAST_NOTIFY_TITLE` | 通知标题主体 |
| `TOAST_NOTIFY_MESSAGE` | 通知正文 |
| `TOAST_NOTIFY_SHELL_PID` | 显式指定当前交互 shell 的 PID |

## dev / 生产区分

通过 `.published` 文件区分：

- 本地开发：无 `.published` 文件 -> `isDev = true` -> 标题显示 `[DEV]`
- 已发布版本：有 `.published` 文件 -> `isDev = false` -> 不加开发标记

文件管理：

- `prepublishOnly`：创建 `.published`
- `postpack`：删除 `.published`

## 当前仍成立的限制

- `SetForegroundWindow` 受 Windows 防焦点窃取策略限制。
- Windows 10 / 11 的 toast 激活实际表现可能不同。
- Windows Terminal tab watcher 只覆盖 WT；其他终端只能做到窗口级或 toast 级提醒。

## 改完 Windows 行为后至少检查什么

- 命令入口：如果动了 direct process launch 路径，确认 `.cmd` 规则没有被破坏。
- 定位：如果动了 `hwnd` / `shellPid` 探测，确认非 WT 与 WT 场景都仍能降级。
- WT：如果动了 tab watcher，确认设色、reset 条件、重复 watcher 防护还在。
- 测试：至少看 [`../test/specs/structure-and-runtime.test.js`](../test/specs/structure-and-runtime.test.js)、[`../test/specs/notification-and-docs.test.js`](../test/specs/notification-and-docs.test.js)、[`../test/specs/smoke.test.js`](../test/specs/smoke.test.js)。
