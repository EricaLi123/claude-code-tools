# Codex Approval 检测与定位

这一页只记录当前仍生效的 approval 设计、配置和取舍。若改动会影响默认路线或定位能力，先回到 [`principles.md`](./principles.md)。带日期的实验过程、机器相关复盘和阶段性结论统一放到 [`history/`](./history/)。

## 要解决的问题

- 普通用户继续直接使用官方 `codex` 时，approval 也要能被提醒到。
- 提醒不只是“知道有 approval”，还要尽量把用户带回原来的窗口 / tab。
- 在拿不到足够证据时，宁可退回窗口级或 Toast-only，也不盲猜 tab。

## 当前结论

- `codex-session-watch` 是普通 Codex CLI 使用场景下的默认 approval 路线。
- `codex-mcp-sidecar` 负责启动期 terminal hint 上报和 watcher 兜底启动；`sessionId -> terminal context` 的解释权收口在 watcher，不替代 watcher。
- approval 定位优先使用精确 `sessionId` 命中；拿不到时宁可降级到窗口级或 Toast-only，也不盲猜 tab。

## 当前采用方案

```text
Codex session start
  → codex-mcp-sidecar
      ├─ 记录启动期 terminal observation
      └─ 确保 codex-session-watch 已运行

Later approval event
  → codex-session-watch
      ├─ 读 rollout JSONL / codex-tui.log
      ├─ 判定 approval
      ├─ reconcile sidecar observation，再决定精确 / fallback 定位
      └─ 发 notify / flash / open / tab hint
```

## 为什么采用这条路线

### 为什么不把 approval 定位完全交给 MCP server

MCP sidecar 擅长的是“Codex 这次是从哪个 terminal 启动的”，而不是“后面某个 approval 事件属于哪个 session / thread / turn”。后者当前仍然要靠 rollout / `codex-tui.log` 这类语义通道补齐。

### 为什么 app-server 不能作为默认主路线

这里的“无感使用”指的是：

- 用户只需要配一次
- 之后继续直接使用官方 `codex`
- 不要求用户改成先启动一个包装器、宿主进程，或者自定义前端

默认如果走 `codex app-server` 主路线，用户就不能只是“配一次，然后继续直接用官方 `codex`”；而是必须把 Codex 放进一个包装器、宿主进程，或自定义前端里，才能让 approval 事件持续经过我们这层。

这和当前项目的根本需求冲突，所以 `app-server` 没被选成默认路线。它更适合“你自己就是 Codex 的宿主 / 集成方”的窄场景，而不是 stock Codex TUI 会话的默认全局 approval 旁听器。

另外，历史验证还证明了：如果不包这层，而是单独拉起一个 `app-server` watcher，它也只能看到自己那条连接里的事件，看不到别的 Codex 会话。相关过程归档在 [`history/legacy-repo-codex-approval-notification-session-2026-03-18.md`](./history/legacy-repo-codex-approval-notification-session-2026-03-18.md)。

## Codex Session Watcher

```text
Codex rollout JSONL (~/.codex/sessions/**/rollout-*.jsonl)
  → bin/cli.js codex-session-watch
      ├─ 单实例锁: %TEMP%\ai-agent-notify\codex-session-watch.lock
      ├─ 周期扫描 rollout 文件
      ├─ 首次启动只读取 session_meta / turn_context，再把 offset 定位到 EOF
      ├─ 后续按 offset 增量读取新增 JSONL 行
      ├─ 监听 event_msg approval 事件
      ├─ 监听 response_item.function_call 中的 require_escalated
      ├─ 同时增量扫描 ~/.codex/log/codex-tui.log
      ├─ 按 sessionId + approvalKind + turnId(+descriptor) 去重
      └─ 若 watcher 已把 sidecar observation reconcile 成精确映射则复用 hwnd / shellPid / isWindowsTerminal
```

### 为什么 watcher 这样设计

**为什么用轮询扫描而不是 `fs.watch`？**

Codex 的 sessions 目录按日期分层创建，`rollout-*.jsonl` 会持续 append。轮询更容易同时覆盖“新目录出现”“新文件出现”“现有文件继续写入”三类情况，行为也更可控。

**为什么首次启动默认从 EOF 开始？**

session watcher 的目标是做“从现在开始”的后台提醒，而不是把历史会话整批重放成通知。首次启动时只抽取元数据，不回放旧事件；之后只处理新增行。

**为什么不保留按 cwd 过滤？**

目标场景是“安装后用户继续直接用 `codex`，后台统一提醒”，而不是让普通用户理解 watcher 自己的工作目录或项目范围。固定全局监听更符合无感使用。

**为什么现在改成由 sidecar 兜底启动 watcher？**

watcher 的存在意义，本来就只发生在“用户已经启动了 Codex session”之后。既然 sidecar 会随 session 自动拉起，那么让它在启动早期顺手检查并隐藏启动 `codex-session-watch`，就能消掉“用户还得额外记得手工开 watcher”这一步。现在 sidecar 还会顺手比较后台 watcher 的 build identity；若发现是旧版本 / 旧源码，会先替换掉再继续复用。

**本地开发 / `npm link` 调试时会怎样？**

- watcher lock 里会写入 build identity；runtime 日志里也会带 `ver=` / `git=` / `dirty=` / `src=` / `install=`，方便确认当前到底跑的是哪一份代码。
- watcher 是否“还是当前这版”并不是看 `version`，也不是看 `dirty`；当前判断条件是 `sourceFingerprint + installKind + packageRoot`。
- 因此，只要你改了会进入 runtime 指纹的文件，也就是 `package.json`、`bin/`、`lib/`、`scripts/` 下的 `.js` / `.json` / `.ps1` / `.vbs`，下一个新启动的 sidecar 就会发现后台 watcher 已经过时，并自动替换掉。
- 如果你只是一直停留在同一个已经打开的 Codex session 里改代码，期间没有新的 sidecar 启动，那么后台 watcher 不会热更新，仍然继续跑旧代码；直到下一次有新 session 启动，sidecar 才会触发替换检查。
- watcher 被替换后会重新扫描现有 rollout 文件并重建自己的内存状态，所以已经存在的其他 session 一般不需要为此重启。
- 像 `docs/`、`test/` 这类不进入 runtime 指纹的改动，不会触发 watcher 替换；这是故意的，因为它们不影响实际运行时代码。

**为什么 session watcher 需要单实例锁？**

即使移除了注册表开机自启，仍然很容易出现“sidecar 已经在后台拉起了一份 watcher，用户又手工执行了一次 `codex-session-watch`”的情况。没有单实例保护时，两份 watcher 会同时扫描同一批 rollout / TUI 日志，最终发出重复 Toast。

### rollout 与 `codex-tui.log` 的信号优先级

| 来源 | watcher 能稳定拿到什么 | watcher 拿不到什么 | 当前用途 | 可靠性判断 |
| --- | --- | --- | --- | --- |
| rollout JSONL | `sessionId`、`turnId`、`cwd`、`event_msg`、`response_item.function_call`、`function_call_output(call_id)`、`session_meta` | 原始本机 `hwnd` / `shellPid`、官方 tab id | approval 主判定、误报抑制、取消 pending 通知 | 最高，结构化事实源 |
| `codex-tui.log` | 较早出现的 `ToolCall: shell_command` 行、部分 `thread.id` / `turn.id` / `submission.id` 文本线索 | 完整结构化 approval 生命周期、稳定的本机终端句柄 | rollout 之前的早期线索、补强 shell escalation 检测 | 次高，早但偏启发式 |

可以简单记成一句话：

- rollout 是“结构化真相”
- `codex-tui.log` 是“更早但更散的文本线索”

approval 主判断仍然是 rollout 优先，因为它同时满足三件事：

1. 字段结构化且稳定
2. 能看到真正的 approval event
3. 能看到后续 `function_call_output`，从而区分“瞬间完成”和“真的卡住待审批”

当前实现仍保留两条信号源：

- rollout structured signal
- TUI fallback signal

是否能删除第二条线，以及为什么它目前仍承担真实命中流量，见 [`history/codex-completion-findings.md`](./history/codex-completion-findings.md)。

### 已批准命令 / 快速完成命令的误报

`codex-session-watch` 需要额外处理一类真实出现过的误报：rollout / TUI 中出现了 `sandbox_permissions == require_escalated` 的 shell tool call，但用户端其实没有看到任何待审批弹窗。

当前收口策略是分层的：

- rollout `response_item.function_call` 一旦已经明确出现 `sandbox_permissions == require_escalated`
  - 视为当前本地最早且最稳的结构化审批信号
  - 直接发通知，不再人为延迟
- 同时先按 `~/.codex/rules/default.rules` 解析 `decision="allow"` 的 `prefix_rule(...)`
  - 如果当前 shell command 已经是已批准命令，则直接 suppress
- 只有当 watcher 手里只有 TUI 的早期文本线索 `ToolCall: shell_command { ... sandbox_permissions=require_escalated ... }`，而还没有 rollout 结构化记录时
  - 才进入 `1 秒 grace 窗口`
  - 若这期间看到匹配的 `function_call_output(call_id=...)`，就取消待发通知

这样做的目标很明确：

- 减少“其实不用你点 approve”却弹 Toast 的误报
- 仍保留真正卡在审批态的通知
- 不把 `Get-Date` 这类仍可能真的触发人工审批的命令粗暴静音

### resumed session / projectDir 回退

`resume` 旧 session 时，精确 `sessionId` 映射并不总能拿到，原因主要有两类：

- 旧 rollout 文件名里的时间戳很老，单看文件名会误判成“不是这次刚启动的 session”
- 如果这是在一个已经运行很久的 Codex 实例里 `resume`，sidecar 甚至未必会重新启动一次

因此当前实现额外补了两层 watcher 侧处理：

- watcher reconcile sidecar observation 时，不只看 rollout 文件名时间，也看文件 `mtime` 和 tail 中最新事件时间
- watcher 找不到精确 `sessionId` 时，会在“仍然存活、但尚未完成精确归因”的 sidecar record 中，按 `projectDir` / `cwd` 的祖先后代关系寻找最可能的窗口

这个回退故意只回退 `hwnd`，不回退 `shellPid`。弱匹配下复用旧 `shellPid` 很容易把颜色刷到错误 tab；窗口级定位还能接受，tab 级误染色则不可接受。

## Codex MCP Sidecar

### Windows 配置路线

当前 Windows 上保留两条配置路线，但 README 公开默认推荐第一条。这里只定义“当前怎么配”；配置路线为什么演进成现在这样，见 [`history/codex-completion-findings.md`](./history/codex-completion-findings.md)。

#### 1. 推荐：全局安装后直配命令

先安装包：

```bash
volta install @erica-s/ai-agent-notify
# or
npm install -g @erica-s/ai-agent-notify
```

然后在 Codex 配置里直接使用命令名：

```toml
notify = ["ai-agent-notify.cmd"]

[mcp_servers.ai_agent_notify_sidecar]
command = "ai-agent-notify.cmd"
args = ["codex-mcp-sidecar"]
required = false
startup_timeout_sec = 30
```

- 这条线适合想去掉 `npx` 启动链、把入口固定为本机已安装命令的场景。
- 这是当前 README 公开推荐的路径：入口固定在本机已安装版本，能避免 `npx` 自动升级后 CLI 行为和项目文档 / 配置结论不同步。
- Windows 上这里显式写 `.cmd`，不要写成 `ai-agent-notify`；原因见 [`windows-runtime.md`](./windows-runtime.md)。

#### 2. 可选备用：直接配置成 `npx`

不做全局安装，配置里直接写 `npx.cmd`：

```toml
notify = ["npx.cmd", "@erica-s/ai-agent-notify"]

[mcp_servers.ai_agent_notify_sidecar]
command = "npx.cmd"
args = ["@erica-s/ai-agent-notify", "codex-mcp-sidecar"]
required = false
startup_timeout_sec = 30
```

- 这条线只适合临时免安装、快速试包或主动跟随最新已发布版本；不再作为 README 默认 public guidance。
- `npx` 在 Windows 上也显式写 `npx.cmd`，不要依赖 `npx` / `npx.ps1` 的命中差异。

```text
~/.codex/config.toml
  → [mcp_servers.ai_agent_notify_sidecar]
       command = "npx.cmd"
       args = ["@erica-s/ai-agent-notify", "codex-mcp-sidecar"]
       startup_timeout_sec = 30
  → Codex 启动 session 时自动拉起 sidecar
      ├─ 若全局 watcher 未运行则隐藏拉起一份
      ├─ 继承 Codex 当时的真实项目目录
      ├─ 记录父链找到的 shellPid / hwnd
      ├─ 写入 cwd + 启动时间 observation
      └─ 让后续的 codex-session-watch 主动 reconcile 成 sessionId 归因
```

### 为什么 sidecar 这样设计

**为什么 sidecar 仍然保留为“配合 watcher”的辅助层，而不是直接替代 watcher？**

sidecar 的优势是“自动随 session 启动”，很适合承担“确保 watcher 已经跑起来”这件事；但它并不会天然收到 approval 事件。真正稳定的 approval 信号仍然来自 rollout JSONL / TUI 日志。

**为什么 sidecar 不自己 resolve sessionId？**

为了把状态解释权收口到 watcher。当前 sidecar 只写启动期 observation：`cwd / hwnd / shellPid / startedAt`；由 watcher 在扫 rollout / TUI 时统一决定何时把 observation reconcile 成精确 `sessionId` 映射、何时只允许窗口级 fallback。

**为什么 sidecar 不暴露任何用户工具？**

它的目标不是给 Codex 增加新能力，而是借用 Codex 自动启动 MCP server 的时机，在本地记录 session 启动期的 terminal 线索。当前实现只返回空的 `tools/list` / `resources/list` / `prompts/list`。

**为什么要求 `mcp_servers.<id>.cwd` 不要显式设置？**

sidecar 需要继承 Codex 当时的真实项目目录，才能把自己和后续 rollout 里的 `cwd` 对上。若把 MCP server 的 `cwd` 固定到包目录或别的路径，匹配就会失真，整个 `sessionId -> terminal` 归因链也就断了。

**为什么 sidecar 只在“精确 sessionId 命中”时才被 watcher 使用？**

这是为了避免把通知重新引到错误窗口。优先路径仍然是 watcher 基于 sidecar observation reconcile 出来的精确 `sessionId` 映射；拿不到精确映射时，只允许再走一层保守的 `projectDir` / `cwd` 窗口级回退，而且只复用 `hwnd`。也就是说：允许“把提醒带回同一项目的大致窗口”，但不允许“把颜色强绑定到某个旧 tab / shellPid”。

**为什么 sidecar 退出后不立刻删除 state record？**

Codex 拉起 MCP server 后，stdio 连接可能很快结束；若 sidecar 退出时立刻删除 `%TEMP%\ai-agent-notify\codex-mcp-sidecar\*.json`，那么后续 watcher 即使已经看到了真实 approval，也查不到这次 session 对应的 `hwnd / shellPid`。因此当前实现改成“保留记录，由 TTL 清理旧 state”。

**为什么不再从 TUI 的 `apply_patch` 日志推断 approval？**

这条启发式在真实 Codex 会话里已经被证伪过。当前实现只保留两类可靠信号：

- rollout JSONL 中真实出现的 `apply_patch_approval_request`
- TUI / rollout 里明确带有 `sandbox_permissions == require_escalated` 的 shell 工具调用

## 相关历史

- [文档总览](./README.md)
- [开发原则](./principles.md)
- [Codex completion 实测结论](./history/codex-completion-findings.md)
- [2026-03-18 legacy repo app-server approval 验证](./history/legacy-repo-codex-approval-notification-session-2026-03-18.md)
