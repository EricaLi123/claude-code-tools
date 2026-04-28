# 架构与职责边界

这一页只回答三件事：

- 项目到底要解决什么问题
- 官方能力的边界在哪里
- 当前为什么拆成 `notify`、`codex-session-watch`、`codex-mcp-sidecar` 三层

更硬的改动护栏见 [`principles.md`](./principles.md)；带日期的实验和排障证据统一放到 [`history/`](./history/)。

## 这页不负责什么

- 不负责给用户写安装步骤和 public guidance，那是 [`../README.md`](../README.md)。
- 不负责展开 approval 的细粒度 signal / fallback 语义，那是 [`codex-approval.md`](./codex-approval.md)。
- 不负责展开 Windows 平台实现细节，那是 [`windows-runtime.md`](./windows-runtime.md)。
- 不负责保存带日期的实验和机器差异，那是 [`history/`](./history/)。

## 根本需求

- 用户只需要配置一次，之后继续直接使用官方 Claude Code / Codex。
- completion 和 approval 都属于产品需求，不能只保留其中一条。
- Windows 下在能做到的前提下，提醒不仅要“弹出来”，还要尽量把用户带回正确窗口 / tab。
- public guidance 要尽量简单，不能把历史排障和机器特例直接堆进用户 README。

## 当前边界

- 默认入口 `ai-agent-notify` 继续统一收口 Claude hook stdin 和 Codex legacy notify argv。
- Codex 官方 hooks 现在已经有公开文档；phase 1 只把 `PermissionRequest` / `Stop`
  接进来，并继续复用现有通知 runtime，而不是再造一套输出层。
- completion 继续走 `notify` 直达，保持 notify-first；`codex-session-watch` 只在 matching completion receipt 仍缺失时做 delayed fallback。
- approval 继续由 `codex-session-watch` 识别，`codex-mcp-sidecar` 只负责记录启动期 terminal observation 和兜底拉起 watcher。
- `InputRequest` 仍由 watcher 负责；hooks 并行期不迁这条 owner 边界。
- `sessionId -> terminal context` 的解释权收口在 watcher，而不是 sidecar。

## 归一化字段契约

- `agentId` 只表示 agent 来源；当前规范值只保留 `claude`、`codex`、`unknown`。
- `entryPointId` 只表示本包代码入口，例如 `notify-mode`、`hooks-mode`、`rollout-watch`、`tui-watch`。
- 不要再把实现路径、历史兼容名、hooks/legacy 细分写进 `agentId`。
- `source` 已从规范字段删除；后续判断和显示都只允许基于 `agentId + entryPointId`。

## 子 agent 通知策略

- watcher 继续跟踪子 session，因为子 agent 可能独立产生真实 `PermissionRequest`。
- 对用户可见的 approval 提醒，事实来源可以是子 session；父 session 只做编排关联，不应把同一次 approval 再复制成一条父通知。
- 对用户可见的 `task_complete` / `Stop`，默认只关注 root / 父 session；子 agent 完成通常只是内部编排细节，不应单独提醒用户。
- 这不等于停止读取子 rollout；对子 session 仍要保留语义监听，只是要抑制子 session 的 completion 类通知。

## 官方约束

- 官方文档当前只把 `notify` 定义为“Codex 在支持的事件上启动一个外部程序，并给它传一个 JSON 参数”。
- 官方文档当前明确说 `notify` 只覆盖 `agent-turn-complete`。
- 官方文档把 `approval-requested` 放在 `tui.notifications` 这一组能力下，而不是 `notify`。
- `tui.notification_method` 只是控制 TUI 自己发 `osc9` / `bel`。
- 官方 hooks 文档已经公开 `PermissionRequest`、`Stop`、`SessionStart` 等事件；当前 phase 1 只接 `PermissionRequest` / `Stop`。
- hooks 配置虽然可以用 `hooks.json` 或 inline `[hooks]`，但当前项目只记录 `hooks.json` 这一个表示，避免并行期出现双表示歧义。

## Hooks 并行期

- 目标是“新判定，旧输出”：hooks 自己做事件检测与标准化，但继续复用 `notify.ps1`、窗口定位、tab 颜色、日志这些既有输出链。
- 并行期不替换旧路线：`notify + codex-session-watch + codex-mcp-sidecar` 继续保留，用户之后再决定是否 cut over。
- phase 1 只接 Codex hooks 的 `PermissionRequest` / `Stop`；InputRequest 仍由 watcher。
- 对账键固定为 `sessionId + turnId + eventName`。
- 当前并行对账策略是 first-arrival emit：先到的一条路径正常发通知；同键后到路径只写并行对账记录并 skip，避免双通知。
- hooks 配置只写 `hooks.json`；不在本文再给 inline `[hooks]` 示例。

## 通道职责拆分

### 能力矩阵

| 通道 | 能稳定拿到 | 拿不到 / 不应假设能拿到 | 适合承担的职责 |
| --- | --- | --- | --- |
| `codex-mcp-sidecar` | session 启动时机、继承的 `cwd`、本机父进程链、可自行探测的 `hwnd` / `shellPid` | 启动瞬间的官方 `sessionId`、`threadId`、`turnId`、approval 事件、官方 tab id | approval 场景的启动期 terminal observation、兜底拉起 watcher |
| Codex legacy `notify` | 一次性 completion payload，常见场景下的 `thread-id` / `turn-id` / `cwd`，以及它触发当场可直接探测到的终端上下文 | approval 请求 | 正常 completion 通知 + completion receipt |
| Codex hooks `hooks.json` | 官方 `session_id` / `turn_id`、hook 事件名、当前 `cwd`，以及 hooks 触发当场可直接探测到的终端上下文 | 旧 watcher 的 rollout 历史、sidecar observation、`InputRequest` | `PermissionRequest` / `Stop` 的官方 hooks 并行验证 |
| `codex-session-watch` | rollout `sessionId`、`task_complete`、approval event、`cwd`、TUI 里的早期 approval 线索 | 启动当场的终端句柄、原始 tab 句柄 | approval 检测 + delayed completion fallback |

### 当前数据流

```text
Completion:
  Codex turn complete
    ├─ 触发 legacy notify
    ├─ ai-agent-notify 用 normalizeIncomingNotification() 统一收口 payload 并在 notify 刚开始时写 completion receipt
    ├─ 同一个 turn 的 rollout 记录 `task_complete`，watcher 把它当作 delayed fallback 候选
    ├─ watcher 先在 grace 窗口做 terminal 准备
    └─ watcher 在真正 emitNotification() 前最后再查一次 receipt；只有 receipt 仍不存在时才判断 notify 失联并补发 fallback `Stop`

Approval:
  Codex session start
    ├─ 自动拉起 codex-mcp-sidecar
    │    ├─ 读取继承到的 cwd
    │    ├─ 在本机父链里找 shellPid / hwnd
    │    ├─ 若 watcher 未运行则隐藏拉起 codex-session-watch
    │    └─ 把“启动期 terminal observation”写到 sidecar state
    └─ 后续真正发生 approval
         ├─ rollout JSONL / codex-tui.log 被 codex-session-watch 看到
         ├─ watcher 得到 sessionId / approvalKind / turnId 等语义线索
         ├─ watcher reconcile sidecar observation，并按 sessionId 查询 sidecar state
         │    ├─ 命中: 复用保存下来的 hwnd / shellPid 做定位增强
         │    └─ 未命中: 先尝试 `projectDir` / `cwd` 窗口级回退；再不行才退回 neutral Toast-only
         └─ notify.ps1 发 toast / flash / open
```

completion 的主路径不走 sidecar；只有 delayed fallback 这一小段 completion 路径，才会落到 `codex-session-watch + codex-mcp-sidecar` 这条组合链。approval 的检测、定位增强和回退仍主要属于这条组合链。

Hooks parallel:
  Codex hooks `PermissionRequest` / `Stop`
    ├─ `~/.codex/hooks.json` 调起 `ai-agent-notify`
    ├─ parser 识别为 `agentId=codex` + `entryPointId=hooks-mode`
    ├─ 先按 `sessionId + turnId + eventName` 写并行对账
    ├─ 若同键还没有其他路径，则继续走共享 notify runtime
    └─ 若 watcher / legacy notify 已经先到，则这条 hooks 记录只做 compare + skip

## 为什么这样拆

### 为什么默认入口要同时兼容 stdin / argv

Claude Code 的 hook 习惯是把 JSON 通过 stdin 传进来；Codex 旧版 `notify` 则把 JSON payload 作为最后一个 argv 追加给命令。当前项目把两种 transport 统一收口到 `normalizeIncomingNotification()`，这样对外只需要一个命令名 `ai-agent-notify`，不必为 Claude / Codex 维护两套入口。

### 为什么 `hwnd` / `shellPid` 查找放在 Node 侧

VSCode/Cursor 集成 git bash 场景下，MSYS2 bash fork 会断开 PowerShell 自身的父进程链，但 `node.exe` 是纯 Win32 进程，其父链更完整，因此在 Node 侧做 `hwnd` / `shellPid` 查找更可靠。

### 为什么 approval 的 session 解释权在 watcher

sidecar 擅长记录“这次 session 从哪个终端启动”；watcher 擅长解释“后面哪个 approval 属于哪个 session”。把 `sessionId -> terminal context` 的解释权收口到 watcher，有几个直接好处：

- approval 语义只在一处定义
- fallback、TTL 和 build replace 这类状态语义不再分散
- sidecar 不需要自己扫描 rollout 或做长期状态解释

## 核心代码入口

| 主题 | 主要文件 |
| --- | --- |
| CLI 总入口与模式分发 | [`../bin/cli.js`](../bin/cli.js) |
| completion / notify payload 收口 | [`../lib/notification-source-parsers.js`](../lib/notification-source-parsers.js) |
| hooks 并行对账 | [`../lib/codex-event-reconciliation.js`](../lib/codex-event-reconciliation.js) |
| 通知 runtime 与日志 | [`../lib/notify-runtime.js`](../lib/notify-runtime.js) |
| 终端上下文探测 | [`../lib/notify-terminal-context.js`](../lib/notify-terminal-context.js) |
| approval watcher 主循环 | [`../lib/codex-session-watch-runner.js`](../lib/codex-session-watch-runner.js) |
| rollout 文件扫描与 metadata | [`../lib/codex-session-watch-files.js`](../lib/codex-session-watch-files.js) |
| approval 事件流处理 | [`../lib/codex-session-watch-streams.js`](../lib/codex-session-watch-streams.js)、[`../lib/codex-session-watch-handlers.js`](../lib/codex-session-watch-handlers.js) |
| sidecar 记录与 reconcile | [`../lib/codex-mcp-sidecar-mode.js`](../lib/codex-mcp-sidecar-mode.js)、[`../lib/codex-sidecar-matcher.js`](../lib/codex-sidecar-matcher.js)、[`../lib/codex-sidecar-store.js`](../lib/codex-sidecar-store.js) |

## 下一步阅读

- [Codex approval 检测与定位](./codex-approval.md)
- [Windows 运行时与通知实现](./windows-runtime.md)
- [历史与实测归档](./history/README.md)
