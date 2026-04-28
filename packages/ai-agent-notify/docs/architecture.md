# 架构与职责边界

这一页只回答三件事：

- 项目到底要解决什么问题
- 官方能力的边界在哪里
- 当前为什么拆成 `notify`、`codex-session-watch`、`codex-mcp-sidecar` 三层

更硬的改动护栏见 [`principles.md`](./principles.md)；带日期的实验和排障证据统一放到 [`history/`](./history/)。

## 这页不负责什么

- 不负责给用户写安装步骤和 public guidance，那是 [`../README.md`](../README.md)。
- 不负责展开 Codex hooks / `InputRequest` 的细粒度操作说明，那是 [`codex-approval.md`](./codex-approval.md)。
- 不负责展开 Windows 平台实现细节，那是 [`windows-runtime.md`](./windows-runtime.md)。
- 不负责保存带日期的实验和机器差异，那是 [`history/`](./history/)。

## 根本需求

- 用户只需要配置一次，之后继续直接使用官方 Claude Code / Codex。
- Claude 的 `Stop` / `PermissionRequest` 和 Codex 的 `Stop` / `PermissionRequest` / `InputRequest` 都要能被提醒。
- Windows 下在能做到的前提下，提醒不仅要“弹出来”，还要尽量把用户带回正确窗口 / tab。
- public guidance 要尽量简单，不能把历史排障和机器特例直接堆进用户 README。

## 当前边界

- 默认入口 `ai-agent-notify` 统一收口 Claude hook stdin、Codex legacy notify argv，以及 Codex 官方 hooks。
- Codex `notify = [...]` 继续作为 `Stop` 的主路径。
- Codex 官方 hooks 负责 `PermissionRequest` 和 `Stop`，统一归一化成 `entryPointId = hooks-mode`。
- watcher 只处理 `InputRequest`。
- `codex-session-watch` 同时读取 rollout JSONL 和 `codex-tui.log`，用双来源补足 `InputRequest`。
- `codex-mcp-sidecar` 负责记录启动期 terminal observation，并兜底确保 watcher 在跑。
- `sessionId -> terminal context` 的解释权保留在 watcher 侧，而不是 sidecar。

## 归一化字段契约

- `agentId` 只表示 agent 来源；当前规范值只保留 `claude`、`codex`、`unknown`。
- `entryPointId` 只表示本包代码入口，例如 `notify-mode`、`hooks-mode`、`rollout-watch`、`tui-watch`。
- 不要再把实现路径、历史兼容名、hooks/legacy 细分写进 `agentId`。
- `source` 已从规范字段删除；后续判断和显示都只允许基于 `agentId + entryPointId`。

## 通道职责拆分

| 通道 | 能稳定拿到 | 拿不到 / 不应假设能拿到 | 适合承担的职责 |
| --- | --- | --- | --- |
| `codex-mcp-sidecar` | session 启动时机、继承的 `cwd`、本机父进程链、可自行探测的 `hwnd` / `shellPid` | 启动瞬间的官方 `sessionId` / `turnId`、官方 hooks 事件体 | 记录 terminal observation、自动拉起 watcher |
| Codex legacy `notify` | `agent-turn-complete` 对应的一次性 completion payload，以及它触发当场可直接探测到的终端上下文 | `PermissionRequest`、`InputRequest` | 正常 `Stop` 通知 |
| Codex hooks `hooks.json` | 官方 `session_id` / `turn_id`、hook 事件名、当前 `cwd` | 本地 rollout 历史、sidecar observation、`InputRequest` | `PermissionRequest` / `Stop` 官方通知 |
| `codex-session-watch` | rollout JSONL、`codex-tui.log`、`sessionId`、`turnId`、`cwd` | 官方 hooks 直接提供的 terminal 上下文 | `InputRequest` 双来源检测与发送 |

## 当前数据流

```text
Stop:
  Claude Stop / Codex legacy notify / Codex hooks Stop
    └─ ai-agent-notify
         ├─ normalizeIncomingNotification()
         ├─ 归一化为 agentId + entryPointId
         ├─ 直接走共享 notify runtime
         └─ 发 toast / flash / open / tab hint

PermissionRequest:
  Claude PermissionRequest / Codex hooks PermissionRequest
    └─ ai-agent-notify
         ├─ normalizeIncomingNotification()
         ├─ 归一化为 agentId + entryPointId=hooks-mode
         └─ 直接走共享 notify runtime

InputRequest:
  Codex session start
    └─ codex-mcp-sidecar
         ├─ 记录启动期 terminal observation
         └─ auto-start `codex-session-watch`

  Later request_user_input
    └─ codex-session-watch
         ├─ 读 rollout JSONL
         ├─ 读 codex-tui.log
         ├─ 归一化为 InputRequest
         ├─ 用 sessionId 做精确 sidecar 匹配
         ├─ 精确命中失败时退回 projectDir / cwd 窗口级 fallback
         └─ 发 notify / flash / open / tab hint
```

## 为什么这样拆

### 为什么默认入口要同时兼容 stdin / argv / hooks

Claude Code 的 hook 习惯是把 JSON 通过 stdin 传进来；Codex 旧版 `notify` 把 JSON payload 作为 argv 传给命令；Codex 官方 hooks 也会直接起本地命令。当前项目把这些 transport 统一收口到 `normalizeIncomingNotification()`，这样对外只需要一个命令名 `ai-agent-notify`，不必为 Claude / Codex 维护多套入口。

### 为什么 `InputRequest` 还保留 watcher

当前官方 Codex hooks 只接 `PermissionRequest` 和 `Stop`。`InputRequest` 仍需要依赖本地 rollout JSONL 和 `codex-tui.log`。因此 watcher 只保留这一条职责，不再承担 approval 或 completion 的补救逻辑。

### 为什么 sidecar 还存在

sidecar 擅长记录“这次 session 从哪个终端启动”；watcher 擅长解释“后面哪个 `InputRequest` 属于哪个 session”。把 `sessionId -> terminal context` 的解释权收口到 watcher，可以保留精确命中与窗口级 fallback 两层策略，同时避免让 sidecar 自己去扫描 rollout。

## 核心代码入口

| 主题 | 主要文件 |
| --- | --- |
| CLI 总入口与模式分发 | [`../bin/cli.js`](../bin/cli.js) |
| notify / hooks / legacy payload 收口 | [`../lib/notification-source-parsers.js`](../lib/notification-source-parsers.js) |
| 通知 runtime 与日志 | [`../lib/notify-runtime.js`](../lib/notify-runtime.js) |
| 终端上下文探测 | [`../lib/notify-terminal-context.js`](../lib/notify-terminal-context.js) |
| watcher 主循环 | [`../lib/codex-session-watch-runner.js`](../lib/codex-session-watch-runner.js) |
| rollout 文件扫描与 metadata | [`../lib/codex-session-watch-files.js`](../lib/codex-session-watch-files.js) |
| watcher 事件流处理 | [`../lib/codex-session-watch-streams.js`](../lib/codex-session-watch-streams.js)、[`../lib/codex-session-watch-handlers.js`](../lib/codex-session-watch-handlers.js) |
| watcher 定位与通知发送 | [`../lib/codex-session-watch-notify.js`](../lib/codex-session-watch-notify.js) |
| sidecar 记录与 reconcile | [`../lib/codex-mcp-sidecar-mode.js`](../lib/codex-mcp-sidecar-mode.js)、[`../lib/codex-sidecar-matcher.js`](../lib/codex-sidecar-matcher.js)、[`../lib/codex-sidecar-store.js`](../lib/codex-sidecar-store.js) |

## 下一步阅读

- [Codex hooks、InputRequest watcher 与 sidecar](./codex-approval.md)
- [Windows 运行时与通知实现](./windows-runtime.md)
- [历史与实测归档](./history/README.md)
