# Codex Approval 检测与定位

这一页只记录当前仍生效的 approval 设计。带日期的实验过程、机器相关复盘和阶段性结论统一放到 [`history/`](./history/)。

## 当前结论

- `codex-session-watch` 是普通 Codex CLI 使用场景下的默认 approval 路线。
- `codex-mcp-sidecar` 负责启动期 terminal hint、watcher 兜底启动和 `sessionId -> terminal context` 桥接，不替代 watcher。
- approval 定位优先使用精确 `sessionId` 命中；拿不到时宁可降级到窗口级或 Toast-only，也不盲猜 tab。

## 角色边界

### 为什么不把 approval 定位完全交给 MCP server

MCP sidecar 擅长的是“Codex 这次是从哪个 terminal 启动的”，而不是“后面某个 approval 事件属于哪个 session / thread / turn”。后者当前仍然要靠 rollout / `codex-tui.log` 这类语义通道补齐。

### 为什么“无感使用”这个要求基本排除了 app-server 主路线

这里的“无感使用”指的是：

- 用户只需要配一次
- 之后继续直接使用官方 `codex`
- 不要求用户改成先启动一个包装器、宿主进程，或者自定义前端

在这个约束下，`codex app-server` 更适合“你自己就是 Codex 的宿主 / 集成方”的窄场景，而不是 stock Codex TUI 会话的默认全局 approval 旁听器。相关验证过程归档在 [`history/codex-approval-notification-session-2026-03-18.md`](./history/codex-approval-notification-session-2026-03-18.md)。

## Codex Session Watcher

```text
Codex rollout JSONL (~/.codex/sessions/**/rollout-*.jsonl)
  → bin/cli.js codex-session-watch
      ├─ 单实例锁: %TEMP%\claude-code-notify\codex-session-watch.lock
      ├─ 周期扫描 rollout 文件
      ├─ 首次启动只读取 session_meta / turn_context，再把 offset 定位到 EOF
      ├─ 后续按 offset 增量读取新增 JSONL 行
      ├─ 监听 event_msg approval 事件
      ├─ 监听 response_item.function_call 中的 require_escalated
      ├─ 同时增量扫描 ~/.codex/log/codex-tui.log
      ├─ 按 sessionId + approvalKind + turnId(+descriptor) 去重
      └─ 若 sidecar 中有精确映射则复用 hwnd / shellPid / isWindowsTerminal
```

### 设计决策

**为什么用轮询扫描而不是 `fs.watch`？**

Codex 的 sessions 目录按日期分层创建，`rollout-*.jsonl` 会持续 append。轮询更容易同时覆盖“新目录出现”“新文件出现”“现有文件继续写入”三类情况，行为也更可控。

**为什么首次启动默认从 EOF 开始？**

session watcher 的目标是做“从现在开始”的后台提醒，而不是把历史会话整批重放成通知。首次启动时只抽取元数据，不回放旧事件；之后只处理新增行。

**为什么不保留按 cwd 过滤？**

目标场景是“安装后用户继续直接用 `codex`，后台统一提醒”，而不是让普通用户理解 watcher 自己的工作目录或项目范围。固定全局监听更符合无感使用。

**为什么现在改成由 sidecar 兜底启动 watcher？**

watcher 的存在意义，本来就只发生在“用户已经启动了 Codex session”之后。既然 sidecar 会随 session 自动拉起，那么让它在启动早期顺手检查并隐藏启动 `codex-session-watch`，就能消掉“用户还得额外记得手工开 watcher”这一步。

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

是否能删除第二条线，以及为什么它目前仍承担真实命中流量，见 [`history/codex-notify-findings.md`](./history/codex-notify-findings.md)。

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

因此当前实现额外补了一层保守回退：

- sidecar 解析候选 session 时，不只看 rollout 文件名时间，也看文件 `mtime` 和 tail 中最新事件时间
- watcher 找不到精确 `sessionId` 时，会在“仍然存活、但尚未完成精确归因”的 sidecar record 中，按 `projectDir` / `cwd` 的祖先后代关系寻找最可能的窗口

这个回退故意只回退 `hwnd`，不回退 `shellPid`。弱匹配下复用旧 `shellPid` 很容易把颜色刷到错误 tab；窗口级定位还能接受，tab 级误染色则不可接受。

## Codex MCP Sidecar

```text
~/.codex/config.toml
  → [mcp_servers.claude_code_notify_sidecar]
       command = "claude-code-notify"
       args = ["codex-mcp-sidecar"]
  → Codex 启动 session 时自动拉起 sidecar
      ├─ 若全局 watcher 未运行则隐藏拉起一份
      ├─ 继承 Codex 当时的真实项目目录
      ├─ 记录父链找到的 shellPid / hwnd
      ├─ 尝试把 cwd + 启动时间匹配到 rollout sessionId
      └─ 让后续的 codex-session-watch 能按 sessionId 做精确归因
```

### 设计决策

**为什么 sidecar 仍然保留为“配合 watcher”的辅助层，而不是直接替代 watcher？**

sidecar 的优势是“自动随 session 启动”，很适合承担“确保 watcher 已经跑起来”这件事；但它并不会天然收到 approval 事件。真正稳定的 approval 信号仍然来自 rollout JSONL / TUI 日志。

**为什么 sidecar 不暴露任何用户工具？**

它的目标不是给 Codex 增加新能力，而是借用 Codex 自动启动 MCP server 的时机，在本地记录 session 启动期的 terminal 线索。当前实现只返回空的 `tools/list` / `resources/list` / `prompts/list`。

**为什么要求 `mcp_servers.<id>.cwd` 不要显式设置？**

sidecar 需要继承 Codex 当时的真实项目目录，才能把自己和后续 rollout 里的 `cwd` 对上。若把 MCP server 的 `cwd` 固定到包目录或别的路径，匹配就会失真，整个 `sessionId -> terminal` 归因链也就断了。

**为什么 sidecar 只在“精确 sessionId 命中”时才被 watcher 使用？**

这是为了避免把通知重新引到错误窗口。当前实现只接受 sidecar 自己解析出的精确 `sessionId` 映射；没有精确映射就放弃定位增强，只保留通知。

**为什么 sidecar 退出后不立刻删除 state record？**

Codex 拉起 MCP server 后，stdio 连接可能很快结束；若 sidecar 退出时立刻删除 `%TEMP%\claude-code-notify\codex-mcp-sidecar\*.json`，那么后续 watcher 即使已经看到了真实 approval，也查不到这次 session 对应的 `hwnd / shellPid`。因此当前实现改成“保留记录，由 TTL 清理旧 state”。

**为什么不再从 TUI 的 `apply_patch` 日志推断 approval？**

这条启发式在真实 Codex 会话里已经被证伪过。当前实现只保留两类可靠信号：

- rollout JSONL 中真实出现的 `apply_patch_approval_request`
- TUI / rollout 里明确带有 `sandbox_permissions == require_escalated` 的 shell 工具调用

## 相关历史

- [Codex notify 实测结论](./history/codex-notify-findings.md)
- [2026-03-18 app-server approval 验证](./history/codex-approval-notification-session-2026-03-18.md)
