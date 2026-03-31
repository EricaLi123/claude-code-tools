# 开发说明

README 只保留安装、配置、常用命令和面向使用者的限制说明；内部实现、信号来源、误报抑制、定位链路和设计取舍统一记录在这里。

## 架构

```
Default notify mode（Claude hook stdin JSON / Codex notify argv JSON / wrapper env JSON）
  → bin/cli.js
      ├─ normalizeIncomingNotification()
      │    ├─ Claude hook stdin JSON
      │    ├─ wrapper 注入的 env JSON
      │    ├─ Codex legacy notify argv JSON
      │    └─ generic JSON payload fallback
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
      └─ spawn scripts/notify.ps1（通过环境变量传入 hwnd、event、title、message、source、log 路径）
            ├─ 用 TOAST_NOTIFY_HWND 发 toast
            └─ flash 任务栏

Codex MCP sidecar（通过 mcp_servers.<id> 自动启动）
  → bin/cli.js codex-mcp-sidecar
      ├─ 若 codex-session-watch 尚未运行：用 start-hidden.vbs 隐藏拉起一份
      ├─ 父链复用 scripts/find-hwnd.ps1，提取 hwnd / shellPid / isWindowsTerminal
      ├─ 记录一份本地 sidecar state：%TEMP%\claude-code-notify\codex-mcp-sidecar\*.json
      ├─ 用继承到的 process.cwd() 作为真实 Codex 项目目录
      ├─ 在短时间窗口内扫描 ~/.codex/sessions/**/rollout-*.jsonl
      │    └─ 按 cwd + 启动时间匹配最可能的 sessionId
      └─ 同时实现一个“空能力” MCP stdio server
           ├─ initialize / ping
           ├─ tools/list → []
           ├─ resources/list → []
           └─ prompts/list → []
```

**为什么默认入口要同时兼容 stdin 和 argv：**
Claude Code 的 hook 习惯是把 JSON 通过 stdin 传进来；Codex 旧版 `notify` 则是把 JSON payload 作为最后一个 argv 追加给命令。当前项目把两者统一收口到 `normalizeIncomingNotification()`，这样对外只需要一个命令名 `claude-code-notify`，不必再为 Claude / Codex 维护两套入口。

**配置约束：尽量不要把 Codex `notify` 长期改成 `node.exe + 本地 bin/cli.js` 直连：**

- 常规方案仍应优先使用发布包形态，或用户机器上实际安装出来的 shim / wrapper 路径。
- 原因不是“直连一定不能工作”，而是它会偏离真实用户安装形态，容易把本地排查路径和 npm 包实际行为混在一起。
- 如果为了隔离某一层 wrapper 问题，临时做一次直连诊断可以接受；但这类配置不应成为默认文档、长期配置，或后续方案设计的前提。

**当前这台 Windows 机器上，Codex completion 的 `notify` 配置实测结论：**

- `notify = ["npx.cmd", "@erica_s/claude-code-notify"]` 不行。
  Codex 会把 completion 的整段 JSON payload 直接作为 argv 传给 notify 命令；这条链在 Windows 上会撞到命令行长度 / 重解析问题。
  `codex-tui.log` 已明确出现：
  `The filename or extension is too long. (os error 206)`
- `notify = ["npx", "@erica_s/claude-code-notify"]` 也不应作为默认方案。
  它和 `npx.cmd` 在 Windows 上并不等价；本机 `Get-Command npx` 命中的是 `npx.ps1`，`Start-Process -FilePath npx --version` 实测直接失败，报 `Access is denied`。
  即使它能启动，也仍会沿用和 `npx.cmd` 相同的“长 JSON argv”链路，因此并不能从根上解决 completion 的 `206` 问题。
- README / 本机默认配置也不写成 `npx.cmd @erica_s/claude-code-notify`。
  原因不只是 payload 长度；窗口定位本身也依赖通知进程 / sidecar 启动当场的父进程链来回溯原始 terminal context。
  如果入口挂在 `npx` 下面，这条链会额外经过 `npx` / shim / launcher，结果通常会退化成“还能发 Toast，但拿不到稳定的 `hwnd` / `shellPid`”。
  这样窗口闪烁、Toast 的 `Open`、以及 Windows Terminal tab 高亮都会失效或退回 Toast-only，因此不适合作为默认文档方案。
- `notify = ["claude-code-notify"]` 也不行。
  这台机器上的 Codex 在拉起 `legacy_notify` 时没有解析到该命令名，`codex-tui.log` 已明确出现：
  `program not found`
- `notify = ["claude-code-notify.cmd"]` 可以解决“命令找不到”这一层，但仍不是最终解。
  改成显式 `.cmd` 后，Codex 已经能拉起 notify；但 completion 的长 JSON payload 仍会在 Windows `.cmd` 参数链上失败。
  最新 `codex-tui.log` 已明确出现：
  `The filename or extension is too long. (os error 206)`
  这说明 `.cmd` 只修复了 command resolution，没有修复长参数传递。
- 还补到一个真实触发条件：`2026-03-31` 本机实测里，一个持续约 15 天、一直未 `clear` 的 Codex 会话开始稳定触发同样的 `os error 206`；执行 `clear` 后，在新会话里同样配置立即恢复正常。
  这至少说明问题不只是“某个 shim 名称写法不对”，也和会话累计后的 completion payload 体积有关；会话越长，越容易把 Windows 这条 argv 链路打爆。
- 因此，裸命令名和 `npx*` 这两类无路径配置，在这台机器上都不能作为稳定结论写进用户文档。
- `.cmd` 也不能作为稳定最终方案写进用户文档；它更适合作为一次性的定位实验，用来证明“Codex 能找到命令，但 `.cmd` 链路仍会被长 payload 打爆”。
- `wscript.exe + %LOCALAPPDATA%\\claude-code-notify\\codex-notify-wrapper.vbs` 能工作，但它要求用户在 `config.toml` 中写绝对路径；从“像一个正常 npm 包一样无感使用”的目标看，这只是临时绕行，不是可接受的最终形态。

**当前更符合这个约束的 Windows completion 兜底方案：**

- 若 `claude-code-notify` 的 `.cmd` / shim 层不能稳定转发 Codex 传来的 JSON argv，
  优先使用 `wscript.exe %LOCALAPPDATA%\\claude-code-notify\\codex-notify-wrapper.vbs`
- 这个 wrapper 仍然调用已安装的 `claude-code-notify` 包入口
- 它只把 payload 先放进 `CLAUDE_CODE_NOTIFY_PAYLOAD` 环境变量，再调用 shim，
  从而绕开 `.cmd %*` 对原始 JSON 的再次展开风险
- 运行时先尝试 `claude-code-notify.cmd`；若当前进程环境里找不到这个 shim，
  再退回 `npx.cmd @erica_s/claude-code-notify`
- 之所以优先选 VBS 而不是 PowerShell wrapper，是因为 PowerShell 自己也会再做一层参数解析，
  在包含大量双引号的 JSON payload 场景下不够稳；`wscript.exe` 这一层更接近“原样收到 argv，再转交环境变量”
- 实测上，改完 `~/.codex/config.toml` 的 `notify` 后，需要重启 Codex 并在新的 TUI session 里复测；
  已经运行中的 session 会继续沿用它启动时解析到的通知命令

**为什么 hwnd 查找在 Node 侧（cli.js）而不是在 notify.ps1 里做：**
VSCode 集成 git bash 场景下，MSYS2 bash fork 会断开 PowerShell 自身的父进程链，
但 Node.exe 是纯 Win32 进程，其父链完整，因此在 Node 侧查找更可靠。

## 官方约束

- 官方文档当前只把 `notify` 定义为：
  Codex 在支持的事件上启动一个外部程序，并给它传一个 JSON 参数
- 官方文档当前明确说 `notify` 只覆盖 `agent-turn-complete`
- 官方文档把 `approval-requested` 放在 `tui.notifications` 这一组能力下，而不是 `notify`
- `tui.notification_method` 只是控制 TUI 自己发 `osc9` / `bel`
- `features.codex_hooks` 在 config reference 里仍是 under development / off by default，
  当前没有公开 lifecycle hook 文档可用于主路线设计

## 提醒 + 定位的职责拆分

### 通道能力矩阵

| 通道 | 能稳定拿到 | 拿不到 / 不应假设能拿到 | 适合承担的职责 |
| --- | --- | --- | --- |
| `codex-mcp-sidecar` | session 启动时机、继承的 `cwd`、本机父进程链、可自行探测的 `hwnd` / `shellPid` | 启动瞬间的官方 `sessionId`、`threadId`、`turnId`、approval 事件、官方 tab id | approval 场景的启动期终端线索、兜底拉起 watcher |
| Codex legacy `notify` | 一次性 completion payload，常见场景下的 `thread-id` / `turn-id` / `cwd`，以及它触发当场可直接探测到的终端上下文 | approval 请求 | 完成类通知 + completion 当场定位 |
| `codex-session-watch` | rollout `sessionId`、approval event、`cwd`、TUI 里的早期 approval 线索 | 启动当场的终端句柄、原始 tab 句柄 | approval 检测 + 提醒触发 |
| `codex-watch` / app-server | `threadId`、`turnId`、approval request payload、command preview、可选 `cwd` | 启动时所在的本机 terminal/tab、`hwnd` | 协议级 approval 语义 |

### 当前项目里的真实数据流

```
Completion：
  Codex turn complete
    ├─ 触发 legacy notify
    ├─ claude-code-notify 当场解析 completion payload
    ├─ cli.js 直接探测当前终端上下文
    └─ notify.ps1 发 toast / flash / open

Approval：
  Codex session start
    ├─ 自动拉起 codex-mcp-sidecar
    │    ├─ 读取继承到的 cwd
    │    ├─ 在本机父链里找 shellPid / hwnd
    │    ├─ 若 watcher 未运行则隐藏拉起 codex-session-watch
    │    └─ 把“启动期终端线索”写到 sidecar state
    │
    └─ 后续真正发生 approval
         ├─ rollout JSONL / codex-tui.log 被 codex-session-watch 看到
         ├─ watcher 得到 sessionId / approvalKind / turnId 等语义线索
         ├─ watcher 按 sessionId 查询 sidecar state
         │    ├─ 命中：复用保存下来的 hwnd / shellPid 做定位增强
         │    └─ 未命中：退回 neutral Toast-only
         └─ notify.ps1 发 toast / flash / open
```

completion 不走 sidecar 这条链。只有 approval 的提醒触发与定位，才是
`codex-session-watch + codex-mcp-sidecar` 的组合结果。

### approval 场景下 watcher 和 sidecar 是怎么配合的

可以把它们理解成两段完全不同时间点的采样：

1. `codex-mcp-sidecar` 只负责 session 启动期
2. `codex-session-watch` 只负责后续真实 approval 事件出现时

sidecar 的优势是它启动得早，正好还站在原始 Codex 终端这条本机进程链上，所以它能拿到这类“本机定位线索”：

- `cwd`
- `hwnd`
- `shellPid`
- `isWindowsTerminal`
- sidecar 自己的启动时间

但 sidecar 的弱点也很明确：MCP 启动协议本身不会把官方 `sessionId`、`threadId`、`turnId` 直接塞给它，所以它只能在启动后的短时间窗口里，再去扫描 `~/.codex/sessions/**/rollout-*.jsonl`，尝试把“这个本机终端”反推到“最可能是哪一个 Codex session”。

watcher 刚好相反。它并不在原始终端进程链里，所以天然拿不到 `hwnd` / `shellPid`；但它能持续看到 rollout / TUI 中后面真正发生的 approval 语义，因此擅长回答：

- 哪个 `sessionId` 触发了 approval
- 这是哪一种 approval
- 属于哪个 `turnId`
- 这次事件对应的 `cwd` / `projectDir`

所以当前项目的拼接方式是：

1. sidecar 先记录“本机终端上下文”
2. sidecar 尽量把这份上下文补成 `sessionId -> terminal context`
3. watcher 后续看到 approval 时，优先按精确 `sessionId` 去 sidecar state 里取回 `hwnd / shellPid`
4. 如果拿不到精确映射，就宁可退回 Toast-only，也不盲猜 tab

### resumed session 为什么还要做 projectDir 回退

`resume` 旧 session 时，精确 `sessionId` 映射并不总能拿到，原因主要有两类：

- 旧 rollout 文件名里的时间戳很老，单看文件名会误判成“不是这次刚启动的 session”
- 如果这是在一个已经运行很久的 Codex 实例里 `resume`，sidecar 甚至未必会重新启动一次

因此当前实现额外补了一层保守回退：

- sidecar 解析候选 session 时，不只看 rollout 文件名时间，也看文件 `mtime` 和 tail 中最新事件时间
- watcher 找不到精确 `sessionId` 时，会在“仍然存活、但尚未完成精确归因”的 sidecar record 中，按 `projectDir` / `cwd` 的祖先后代关系寻找最可能的窗口

这个回退故意只回退 `hwnd`，不回退 `shellPid`。因为弱匹配下复用旧 `shellPid` 很容易把颜色刷到错误 tab；窗口级定位还能接受，tab 级误染色则不可接受。

### 为什么不把 approval 定位完全交给 MCP server

因为 MCP sidecar 擅长的是“Codex 这次是从哪个 terminal 启动的”，而不是“后面某个 approval 事件属于哪个 session / thread / turn”。后者当前仍然要靠 rollout / TUI / app-server 这类会话语义通道补齐。

### 为什么“无感使用”这个要求基本排除了 app-server 主路线

这里的“无感使用”指的是：

- 用户只需要配一次
- 之后继续直接使用官方 `codex`
- 不要求用户改成先启动一个包装器、宿主进程，或者自定义前端

在这个约束下，`codex app-server` 不适合作为主方案，原因有两层：

1. 它更适合“你自己就是 Codex 的宿主 / 集成方”
2. 它不天然等于“后台额外开一条连接，就能全局观察所有别的 Codex 会话”

当前项目里已经做过实测：后台独立拉起的 `codex-watch` 可以观察到**它自己那条 app-server 连接**里的 thread 状态，但不能稳定充当“用户其他官方 Codex TUI 会话”的全局 approval 观察器。

所以，如果目标是：

- 不改用户日常 `codex` 使用方式
- 不要求用户理解 app-server 生命周期
- 配完后尽量无感

那 app-server 更适合作为：

- 协议研究 / 调试工具
- 窄范围集成模式

而不是普通用户的默认通知主路径。

### 在“无感使用”前提下，当前更合理的职责分配

重新查过官方文档和本机日志后，当前更稳妥的默认主路线是：

1. 用户继续直接启动官方 `codex`
2. 我们的顶层 `notify` 继续负责 completion 通知与 completion 当场定位
3. `codex-session-watch` 负责 approval 检测与提醒触发
4. `codex-session-watch + codex-mcp-sidecar` 一起负责 approval 的定位增强

这里有两个容易混淆但必须区分的点：

- `codex app-server`
  - 它拥有最精确的 live approval transport
  - 但它更适合“你自己托管 Codex / 自己做客户端集成”的场景
  - 它不是普通 stock Codex TUI 会话的默认全局旁听器
- `tui.notifications` / `tui.notification_method`
  - 它们控制的是 TUI 自己的终端通知行为
  - 但当前并不是一个稳定的外部自动化入口
  - 本地也没有发现一个可稳定复用的“notification_method 已执行”持久化日志

所以对普通 CLI 用户来说，当前项目的默认策略不是“接管官方 TUI 通知”，而是：

- completion 继续走 `notify` 直达
- 用 rollout / TUI 本地日志自己识别 approval
- 用 sidecar 补回 approval 对应的原始 terminal / tab 身份
- 把 app-server 保留为更窄的协议研究 / 自定义集成路径

## Codex Session Watcher

```
Codex rollout JSONL (~/.codex/sessions/**/rollout-*.jsonl)
  → bin/cli.js codex-session-watch
      ├─ 先拿 `%TEMP%\claude-code-notify\codex-session-watch.lock`
      │    └─ 避免用户登录自启动后又手工跑一份 watcher，导致重复通知
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
      ├─ 若 sidecar state 中存在该 sessionId 的精确映射：
      │    └─ 复用保存下来的 hwnd / shellPid / isWindowsTerminal
      └─ 复用 notify.ps1 发 Toast
```

### 设计决策

**为什么用轮询扫描而不是 `fs.watch`？**

Codex 的 sessions 目录是按日期分层创建的，`rollout-*.jsonl` 会持续 append。轮询扫描更容易同时覆盖“新目录出现”“新文件出现”“现有文件继续写入”三类情况，行为也更可控。

**为什么首次启动默认从 EOF 开始？**

session watcher 目标是做“从现在开始”的后台提醒，而不是把历史会话整批重放成通知。首次启动时只抽取元数据（sessionId、cwd），不回放旧事件；之后只处理新增行。

**为什么不保留按 cwd 过滤？**

目标场景是“安装后用户继续直接用 `codex`，后台统一提醒”，而不是让普通用户理解 watcher 自己的工作目录或项目范围。固定全局监听更符合无感使用，也避免了 watcher 被错误地从某个目录启动后只盯住单个项目。

**为什么现在改成由 sidecar 兜底启动 watcher？**

watcher 的存在意义，本来就只发生在“用户已经启动了 Codex session”之后。既然 MCP sidecar 会随 session 自动拉起，那么让它在启动早期顺手检查并隐藏启动 `codex-session-watch`，就能消掉“用户还得额外记得手工开 watcher”这一步，同时又不需要回到包装 `codex` 启动命令的方案。

**为什么要额外做 `autostart` 命令，而不是要求用户每次手工开 watcher？**

`codex-session-watch` 是一个长期驻留的后台观察者，它和单次通知命令不一样。现在主路径已经变成“由 sidecar 在第一次 Codex session 启动时兜底拉起”；但仍然保留 `autostart`，是为了给“不想依赖 sidecar”“希望 watcher 在第一条 session 之前就已经在线”的用户一个显式选项。

**为什么自启动用 HKCU Run + `wscript.exe` 隐藏启动，而不是安装时直接偷偷常驻？**

这个 watcher 会长期驻留，因此是否开机自启应该是用户显式决定的行为，而不是 npm install 的隐式副作用。当前实现把它做成 `claude-code-notify autostart enable|disable|status` 显式命令；真正启动时则通过 HKCU 的 `Run` 注册表项在用户登录时拉起，并借助 `scripts/start-hidden.vbs` 隐藏窗口，避免额外弹出一个无意义的控制台。

**为什么 session watcher 还需要单实例锁？**

一旦支持登录自启动，就很容易出现“后台已经有一份 watcher，用户又手工执行了一次 `codex-session-watch`”的情况。如果没有单实例保护，两份 watcher 会同时扫描同一批 rollout / TUI 日志，最终发出重复 Toast。当前实现用 `%TEMP%\claude-code-notify\codex-session-watch.lock` 做进程级互斥；发现已有存活实例时，新进程直接退出。

**为什么 session watcher 现在仍然默认是“保守定位”，而不是盲目带上 HWND / shell pid？**

它本身仍然是一个全局后台观察者，不在原始 Codex 终端的进程链里。直接复用 watcher 自己的 HWND 只会把 `Open` / 闪烁指到错误窗口。

现在新增的做法是：只有当 `codex-mcp-sidecar` 在 session 启动时成功解析出了**精确的 `sessionId -> terminal context` 映射**时，watcher 才会复用那份保存下来的 `hwnd / shellPid / isWindowsTerminal`。如果拿不到精确映射，仍然退回到原来的全局 Toast-only 行为，而不是冒险猜测。

补充一点：`resume` 旧 session 时，sidecar 还有两种不同路径。

- 如果这是在一个**新启动的 Codex 实例**里 resume，sidecar 现在会同时参考 rollout 文件名时间、文件最近写入时间、以及 tail 里的最新事件时间；这样旧 session 也有机会重新解析出精确 `sessionId`
- 如果这是在一个**已经长期运行的 Codex 实例**里 resume，sidecar 本身未必会为这个线程重新启动。此时 watcher 只能做一个更保守的回退：在仍存活但尚未解析出 `sessionId` 的 sidecar 记录里，按 `cwd` 的祖先/后代关系匹配出最可能的窗口 `hwnd`

这个回退故意只补窗口级定位，不补 tab 级 `shellPid`。原因很直接：未解析出精确 `sessionId` 时，复用旧的 `shellPid` 很容易把颜色刷到错误 tab 上。

### watcher 到底从 rollout 和 `codex-tui.log` 看到了什么

| 来源 | watcher 能稳定拿到什么 | watcher 拿不到什么 | 当前用途 | 可靠性判断 |
| --- | --- | --- | --- | --- |
| rollout JSONL | `sessionId`、`turnId`、`cwd`、`event_msg`、`response_item.function_call`、`function_call_output(call_id)`、`session_meta` | 原始本机 `hwnd` / `shellPid`、官方 tab id | approval 主判定、误报抑制、取消 pending 通知 | 最高，结构化事实源 |
| `codex-tui.log` | 较早出现的 `ToolCall: shell_command` 行、部分 `thread.id` / `turn.id` / `submission.id` 文本线索 | 完整结构化 approval 生命周期、稳定的本机终端句柄 | rollout 之前的早期线索、补强 shell escalation 检测 | 次高，早但偏启发式 |

可以简单记成一句话：

- rollout 是“结构化真相”
- `codex-tui.log` 是“更早但更散的文本线索”

#### rollout 里最关键的几类记录

- `session_meta`
  - 提供 session 级基础信息，能拿到 `sessionId`
- `turn_context`
  - 提供该轮上下文，常能拿到 `cwd`
- `event_msg`
  - 这是 `exec_approval_request`、`request_permissions`、`apply_patch_approval_request` 这类真 approval 事件的主要来源
- `response_item.function_call`
  - 这里能看到工具调用参数，例如 `sandbox_permissions == require_escalated`
- `function_call_output`
  - 这是误报抑制的重要信号。若同一个 `call_id` 很快就输出完成，说明它未必真的长时间停留在用户审批态

#### `codex-tui.log` 里最关键的几类线索

- `ToolCall: shell_command { ... sandbox_permissions=require_escalated ... }`
  - 用来尽早发现 shell escalation
- 某些 `thread.id` / `turn.id` / `submission.id`
  - 这些能帮助做上下文关联，但并不稳定，也不是每次都有
- 普通文本日志
  - 适合作为“早知道一点”的提示，不适合作为最终唯一真相源

#### 为什么 approval 主判断还是 rollout 优先

因为 rollout 同时满足三个条件：

1. 结构化，字段稳定
2. 能看到真正的 approval event
3. 能看到后续 `function_call_output`，从而把“瞬间完成”与“真的卡住待审批”区分开

而 `codex-tui.log` 的局限是：

1. 它更像调试输出，不是为外部 watcher 设计的协议
2. 某些字段是文本拼接出来的，不保证每个版本都同形
3. 它常常能更早出现，但未必能完整表达“这个 approval 后来是否马上就结束了”

### 已批准命令 / 快速完成命令的误报

`codex-session-watch` 现在还要额外处理一类真实出现过的误报：rollout /
TUI 中出现了 `sandbox_permissions == require_escalated` 的 shell tool
call，但用户端其实没有看到任何待审批弹窗。

根因不是 watcher 看错了日志，而是它以前把下面两类情况都当成了
“Needs Approval”：

- 命令其实已经命中了 `~/.codex/rules/default.rules` 里的已批准规则
- 命令虽然走了 `require_escalated`，但很快就自动完成，并没有停留在用户审批态

这类误报在 `2026-03-25 17:44` / `17:46` 的那次会话里已经被日志证实过：
同一个 session 的几条 `require_escalated` 读命令在 0.3s / 0.8s 内就返回
了 `function_call_output`，但旧 watcher 仍然立刻发了通知。

当前收口策略是分层的：

- rollout `response_item.function_call` 里一旦已经明确出现
  `sandbox_permissions == require_escalated`
  - 这被视为当前本地最早且最稳的结构化审批信号
  - 直接发通知，不再人为延迟
- 同时先按 `~/.codex/rules/default.rules` 解析 `decision="allow"` 的
  `prefix_rule(...)`
  - 如果当前 shell command 已经是已批准命令，则直接 suppress
- 只有当 watcher 手里只有 TUI 的早期文本线索
  `ToolCall: shell_command { ... sandbox_permissions=require_escalated ... }`
  而还没有 rollout 结构化记录时
  - 才进入 1 秒 grace 窗口
  - 若这期间看到匹配的 `function_call_output(call_id=...)`，就取消待发通知

这样做的目的很明确：

- 减少“其实不用你点 approve”却弹 Toast 的误报
- 仍保留真正卡在审批态的通知
- 不把 `Get-Date` 这类仍可能真的触发人工审批的命令粗暴静音

### 2026-03-27 实测结论：第二条线现在还不能删

`2026-03-27` 这轮针对真实 approval 的 watcher 日志复看后，能确认一件事：
最近几次**真正弹出来**的 approval 通知，命中的主要还是：

- `ToolCall: shell_command ... require_escalated`
- `queued approval pending`
- grace 窗口结束后 `pending event matched`
- 然后才真正发 toast / flash / tab 高亮

也就是说，这些案例实际走的是 **TUI fallback -> pending -> emit** 这条线，
而不是 rollout 结构化 `response_item.function_call` 的 immediate 分支。

因此当前不能简单删掉第二条线。至少按这批真实日志看：

- 如果只保留 rollout immediate，那这些 approval 会直接漏掉
- 第二条线当前不是“多余兜底”，而是仍然承担着真实命中流量

更准确的理解应当是：

- 现在不是两套彼此独立的提醒系统
- 而是两个信号源：
  - rollout structured signal
  - TUI fallback signal
- 最后汇入同一个 approval 通知出口

后续该继续优化的是：

- 为什么某些真实 approval 没有稳定命中 rollout immediate
- 能否缩短 pending 体感延迟而不重新引入误报
- 能否让第二条线更多地承担“补缺”而不是“主命中”

## Codex MCP Sidecar

```
~/.codex/config.toml
  → [mcp_servers.claude_code_notify_sidecar]
       command = "claude-code-notify"
       args = ["codex-mcp-sidecar"]
  → Codex 启动 session 时自动拉起 sidecar
      ├─ sidecar 先检查全局 watcher 是否已存在；没有就隐藏拉起一份
      ├─ sidecar 继承 Codex 当时的工作目录（必须不显式设置 mcp_servers.<id>.cwd）
      ├─ 记录父链找到的 shellPid / hwnd
      ├─ 尝试把 cwd + 启动时间匹配到 rollout sessionId
      └─ 让后续的 codex-session-watch 能按 sessionId 做精确归因
```

### 设计决策

**为什么 sidecar 仍然保留为“配合 watcher”的辅助层，而不是直接替代 watcher？**

MCP sidecar 的优势是“自动随 session 启动”，所以它很适合承担“确保 watcher 已经跑起来”这件事；但它并不会天然收到 approval 事件。真正稳定的 approval 信号仍然来自 rollout JSONL / TUI 日志，因此 sidecar 更适合作为“启动时埋点 + watcher 启动器 + 终端定位桥接层”，而不是审批检测器本身。

**为什么 sidecar 不暴露任何用户工具？**

它的目标不是给 Codex 增加新能力，而是借用 Codex 自动启动 MCP server 的时机，在本地记录 session 启动期的 terminal 线索。当前实现只返回空的 `tools/list` / `resources/list` / `prompts/list`，避免给用户暴露无意义的工具项。

**为什么要求 `mcp_servers.<id>.cwd` 不要显式设置？**

sidecar 需要继承 Codex 当时的真实项目目录，才能把自己和后续 rollout 里的 `cwd` 对上。如果把 MCP server 的 `cwd` 固定到包目录或别的路径，匹配就会失真，整个 `sessionId -> terminal` 归因链也就断了。

**为什么 sidecar 只在“精确 sessionId 命中”时才被 watcher 使用？**

这是为了避免把通知重新引到错误窗口。单看 `cwd` 或启动时间做猜测，在“同一项目开多个 Codex 会话”的情况下仍然可能误配。当前实现只接受 sidecar 自己解析出的精确 `sessionId` 映射；没有精确映射就直接放弃定位增强，只保留通知。

**为什么 sidecar 退出后不立刻删除 state record？**

实测里，Codex 拉起 MCP server 后，stdio 连接可能很快结束；如果 sidecar 在退出清理阶段立刻删掉 `%TEMP%\\claude-code-notify\\codex-mcp-sidecar\\*.json`，那么后续 `codex-session-watch` 即使已经看到了真实 approval，也查不到这次 session 对应的 `hwnd / shellPid`。因此当前实现改成：

- sidecar 在短时间窗口内继续等待 `sessionId` 解析完成
- 解析出的 `sessionId -> terminal` 记录保留到临时目录
- 由 TTL 清理旧记录，而不是把“sidecar 进程还活着”当成记录是否可信的前提

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

这里还要再补一个产品层面的结论：如果把“用户只配一次，之后继续无感使用官方 `codex`”当成硬要求，那么 `codex-watch` / app-server 路线天然就更不适合做默认主方案。因为它更像“自建宿主集成”，而不是“附着在现有官方 CLI 上的无感增强”。

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
