# Codex Approval 检测与定位

这一页是给开发者和 AI 的 approval 主手册。它只记录当前仍生效的设计、约束和改动判断。带日期的实验和机器相关复盘统一放到 [`history/`](./history/)。

## 这页不负责什么

- 不负责 completion 通知路线，那是 [`architecture.md`](./architecture.md) 和 [`../README.md`](../README.md)。
- 不负责 Windows 图标、窗口探测和 WT tab watcher 的实现细节，那是 [`windows-runtime.md`](./windows-runtime.md)。
- 不负责保存带日期的排障过程，那是 [`history/`](./history/)。

## 先看结论

- 默认 approval 路线是 `codex-session-watch`，不是 `notify`，也不是单独的 `app-server` watcher。
- phase 1 可以把官方 hooks `PermissionRequest` 并行接进来做验证，但这不改变默认 approval owner 仍是 `codex-session-watch`。
- `codex-mcp-sidecar` 只负责记录启动期 terminal observation 和确保 watcher 在跑；`sessionId -> terminal context` 的解释权收口在 watcher。
- 定位优先级是：精确 `sessionId` 命中 > `projectDir` / `cwd` 窗口级回退 > neutral Toast-only。
- 拿不到足够证据时宁可降级，也不盲猜 tab。

## 如果你要改 approval，先判断改的是哪一层

| 你要改的东西 | 应先看什么 | 当前 owner |
| --- | --- | --- |
| approval 事件怎么被发现 | rollout / TUI 信号优先级 | `codex-session-watch` |
| `sessionId -> terminal` 怎么解释 | sidecar observation + watcher reconcile | `codex-session-watch` |
| session 启动时记录什么终端线索 | startup observation | `codex-mcp-sidecar` |
| 通知如何落地到窗口 / tab | Windows 运行时 | [`windows-runtime.md`](./windows-runtime.md) |
| 是否能把路线换成 `app-server` | 默认路线边界 | [`history/legacy-repo-codex-approval-notification-session-2026-03-18.md`](./history/legacy-repo-codex-approval-notification-session-2026-03-18.md) |

## 当前数据流

```text
Codex session start
  → codex-mcp-sidecar
      ├─ 记录启动期 terminal observation
      └─ 确保 codex-session-watch 已运行

Later approval event
  → codex-session-watch
      ├─ 读 rollout JSONL / codex-tui.log
      ├─ 判定 approval
      ├─ reconcile sidecar observation
      ├─ 先尝试精确 sessionId 定位
      ├─ 失败时再做窗口级 fallback
      └─ 发 notify / flash / open / tab hint

Optional phase 1 hooks parallel
  → `~/.codex/hooks.json`
      ├─ 只接 `PermissionRequest`
      ├─ 先按 `sessionId + turnId + eventName` 做并行对账
      └─ 若 watcher 还没先到，则复用同一套 notify runtime 发提醒
```

## 核心代码入口

| 主题 | 主要文件 |
| --- | --- |
| watcher 生命周期、单实例锁、build replace | [`../lib/codex-session-watch-runner.js`](../lib/codex-session-watch-runner.js) |
| rollout 扫描与元数据读取 | [`../lib/codex-session-watch-files.js`](../lib/codex-session-watch-files.js) |
| 增量消费 rollout / TUI | [`../lib/codex-session-watch-streams.js`](../lib/codex-session-watch-streams.js)、[`../lib/codex-session-watch-handlers.js`](../lib/codex-session-watch-handlers.js) |
| approval 定位与通知发送 | [`../lib/codex-approval-notify.js`](../lib/codex-approval-notify.js) |
| pending / batch / grace 窗口 | [`../lib/codex-approval-pending.js`](../lib/codex-approval-pending.js) |
| 已批准命令抑制 | [`../lib/codex-approval-rules.js`](../lib/codex-approval-rules.js)、[`../lib/codex-approval-session-grants.js`](../lib/codex-approval-session-grants.js) |
| sidecar reconcile / fallback 查找 | [`../lib/codex-sidecar-matcher.js`](../lib/codex-sidecar-matcher.js) |
| sidecar 启动期 observation 记录 | [`../lib/codex-mcp-sidecar-mode.js`](../lib/codex-mcp-sidecar-mode.js)、[`../lib/codex-sidecar-store.js`](../lib/codex-sidecar-store.js) |
| MCP 空 server 响应 | [`../lib/codex-mcp-server.js`](../lib/codex-mcp-server.js) |

## 为什么不是别的路线

### 为什么不把 approval 定位完全交给 MCP server

MCP sidecar 擅长的是“Codex 这次从哪个 terminal 启动”，而不是“后面这个 approval 属于哪个 session / turn”。后者仍然要靠 rollout / `codex-tui.log` 这类语义通道补齐。

### 为什么 app-server 不能作为默认主路线

项目根本需求是：

- 用户只需要配一次
- 之后继续直接使用官方 `codex`
- 不需要额外包一层宿主、包装器或自定义前端

`codex app-server` watcher 做不到这一点。它更适合“你自己就是 Codex 宿主 / 集成方”的窄场景，而不是 stock Codex TUI 的默认全局 approval 路线。历史验证还证明：单独拉起的 `app-server` watcher 只能看到自己那条连接里的事件，看不到别的 Codex 会话。相关归档见 [`history/legacy-repo-codex-approval-notification-session-2026-03-18.md`](./history/legacy-repo-codex-approval-notification-session-2026-03-18.md)。

## Watcher：真正的 approval owner

```text
Codex rollout JSONL (~/.codex/sessions/**/rollout-*.jsonl)
  → bin/cli.js codex-session-watch
      ├─ 单实例锁: %TEMP%\ai-agent-notify\codex-session-watch.lock
      ├─ 周期扫描 rollout 文件
      ├─ 首次启动只读取 session_meta / turn_context，再把 offset 定位到 EOF
      ├─ 后续按 offset 增量读取新增 JSONL 行
      ├─ 监听 event_msg approval
      ├─ 监听 response_item.function_call.require_escalated
      ├─ 同时增量扫描 ~/.codex/log/codex-tui.log
      ├─ 按 sessionId + approvalKind + turnId(+descriptor) 去重
      └─ 在命中精确映射时复用 hwnd / shellPid / isWindowsTerminal
```

### 当前 watcher 设计要点

- 用轮询，不用 `fs.watch`：因为 sessions 目录会新建目录、追加文件、继续 append，轮询更稳定。
- 首次启动默认从 EOF 开始：目标是“从现在开始”的后台提醒，不是重放历史事件。
- 不做按 `cwd` 过滤：目标是全局后台提醒，不是让普通用户理解 watcher 自己的作用域。
- 需要单实例锁：否则 sidecar 自动拉起和用户手工执行可能并存，最终发出重复通知。

### sidecar 为什么要兜底启动 watcher

watcher 的存在意义本来就只发生在“用户已经启动了 Codex session”之后。既然 sidecar 会随 session 自动拉起，就让它在启动早期顺手检查并隐藏启动 `codex-session-watch`。现在 sidecar 还会比较后台 watcher 的 build identity；若发现是旧版本 / 旧源码，会先替换掉再继续复用。

### 本地开发 / `npm link` 调试时会怎样？

- watcher lock 里会写入 build identity；runtime 日志里也会带 `ver=` / `git=` / `dirty=` / `src=` / `install=`。
- watcher 是否“还是当前这版”并不是看 `version`，也不是看 `dirty`；当前判断条件是 `sourceFingerprint + installKind + packageRoot`。
- 只要你改了会进入 runtime 指纹的文件，也就是 `package.json`、`bin/`、`lib/`、`scripts/` 下的 `.js` / `.json` / `.ps1` / `.vbs`，下一个新启动的 sidecar 就会发现后台 watcher 已经过时，并自动替换掉。
- 如果你一直停留在同一个已打开的 Codex session 里改代码，期间没有新的 sidecar 启动，那么后台 watcher 不会热更新；直到下一次有新 session 启动，sidecar 才会触发替换检查。
- watcher 被替换后会重新扫描现有 rollout 文件并重建自己的内存状态，所以已经存在的其他 session 一般不需要为此重启。
- `docs/`、`test/` 这类不进入 runtime 指纹的改动不会触发 watcher 替换；这是故意的。

## 信号优先级

| 来源 | watcher 能稳定拿到什么 | watcher 拿不到什么 | 当前用途 | 可靠性判断 |
| --- | --- | --- | --- | --- |
| rollout JSONL | `sessionId`、`turnId`、`cwd`、`event_msg`、`response_item.function_call`、`function_call_output(call_id)`、`session_meta` | 原始本机 `hwnd` / `shellPid`、官方 tab id | approval 主判定、误报抑制、取消 pending 通知 | 最高，结构化事实源 |
| `codex-tui.log` | 较早出现的 `ToolCall: shell_command` 行、部分 `thread.id` / `turn.id` / `submission.id` 文本线索 | 完整结构化 approval 生命周期、稳定的本机终端句柄 | rollout 之前的早期线索、补强 shell escalation 检测 | 次高，早但偏启发式 |

一句话概括：

- rollout 是结构化真相
- `codex-tui.log` 是更早但更散的文本线索

因此当前实现仍保留两条信号源：

- rollout structured signal
- TUI fallback signal

不要把 rollout 优先误写成“`TUI fallback` 已经没有真实流量”。为什么第二条线目前仍不能删，见 [`history/codex-completion-findings.md`](./history/codex-completion-findings.md)。

## 误报抑制

`codex-session-watch` 需要处理一类真实出现过的误报：rollout / TUI 中出现了 `sandbox_permissions == require_escalated` 的 shell tool call，但用户端其实没有看到任何待审批弹窗。

当前收口规则：

- 如果 rollout `response_item.function_call` 已经明确出现 `sandbox_permissions == require_escalated`
  - 视为本地最早且最稳的结构化审批信号
  - 直接发通知，不再人为延迟
- 同时先按 `~/.codex/rules/default.rules` 解析 `decision="allow"` 的 `prefix_rule(...)`
  - 如果当前 shell command 已经是已批准命令，则直接 suppress
- 只有当 watcher 手里只有 TUI 早期线索，而还没有 rollout 结构化记录时
  - 才进入 `1 秒 grace 窗口`
  - 如果这期间看到匹配的 `function_call_output(call_id=...)`，就取消待发通知

目标只有三个：

- 减少误报
- 保留真实卡在审批态的通知
- 不把仍可能触发人工审批的命令粗暴静音

## resumed session / fallback 规则

`resume` 旧 session 时，精确 `sessionId` 映射并不总能拿到，常见原因有两个：

- 旧 rollout 文件名里的时间戳很老，单看文件名会误判
- 如果是在一个已经运行很久的 Codex 实例里 `resume`，sidecar 甚至未必会重新启动一次

因此 watcher 额外做两层处理：

- reconcile sidecar observation 时，不只看 rollout 文件名时间，也看文件 `mtime` 和 tail 中最新事件时间
- 找不到精确 `sessionId` 时，会在“仍然存活、但尚未完成精确归因”的 sidecar record 中，按 `projectDir` / `cwd` 的祖先后代关系寻找最可能的窗口

这个回退故意只回退 `hwnd`，不回退 `shellPid`。弱匹配下复用旧 `shellPid` 很容易把颜色刷到错误 tab；窗口级定位还能接受，tab 级误染色则不可接受。

## Sidecar：只记录 observation，不解释 approval

### 当前配置

README 公开默认推荐已安装命令直配；这里只保留当前仍生效的配置事实。

推荐路线：

```toml
[features]
codex_hooks = true

notify = ["ai-agent-notify.cmd"]

[mcp_servers.ai_agent_notify_sidecar]
command = "ai-agent-notify.cmd"
args = ["codex-mcp-sidecar"]
required = false
startup_timeout_sec = 30
```

可选备用路线：

```toml
notify = ["npx.cmd", "@erica-s/ai-agent-notify"]

[mcp_servers.ai_agent_notify_sidecar]
command = "npx.cmd"
args = ["@erica-s/ai-agent-notify", "codex-mcp-sidecar"]
required = false
startup_timeout_sec = 30
```

无论哪条线，Windows direct process launch 语境下都显式写 `.cmd`；原因见 [`windows-runtime.md`](./windows-runtime.md)。

如果要并行验证官方 Codex hooks，还要额外满足两点：

- `config.toml` 里显式打开 `features.codex_hooks = true`
- `~/.codex/hooks.json` 使用官方当前要求的顶层结构：`{ "hooks": { ... } }`
- Codex 当前会跳过带 `async: true` 的 hooks，所以 command hook 这里要写同步形式

### 当前 sidecar 约束

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

## 改完 approval 后至少检查什么

- 代码：确认 watcher owner 边界没有重新散回 sidecar。
- 文档：如果改了默认路线、fallback 语义或 signal 优先级，更新本页和 [`architecture.md`](./architecture.md)。
- 测试：至少看 [`../test/specs/sidecar.test.js`](../test/specs/sidecar.test.js)、[`../test/specs/approval-suppression.test.js`](../test/specs/approval-suppression.test.js)、[`../test/specs/codex-events.test.js`](../test/specs/codex-events.test.js)、[`../test/specs/structure-and-runtime.test.js`](../test/specs/structure-and-runtime.test.js)。
