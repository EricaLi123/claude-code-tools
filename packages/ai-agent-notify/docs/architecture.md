# 架构与职责边界

这一页只回答三件事：

- 项目到底要解决什么问题
- 官方能力的边界在哪里
- 当前为什么拆成 `notify`、Codex hooks、`codex-session-watch` 三层

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
- Codex 官方 hooks 负责 `SessionStart`、`PermissionRequest` 和 `Stop`。
- direct notify 不再拆父子程序；是否打断 Codex UI 等待，交给 `hooks.json` 的 `timeout` 控制。
- watcher 只处理 `InputRequest`。
- `codex-session-watch` 同时读取 rollout JSONL 和 `codex-tui.log`，用双来源补足 `InputRequest`。
- `SessionStart` hook 当场做本地 terminal 探测，并记录精确 `sessionId -> terminal context`。
- watcher 只做精确 session 命中；拿不到记录时降级成 neutral Toast-only，不再做 `projectDir` 窗口级猜测。

## 归一化字段契约

- `agentId` 只表示 agent 来源；当前规范值只保留 `claude`、`codex`、`unknown`。
- `entryPointId` 只表示本包代码入口，例如 `notify-mode`、`hooks-mode`、`rollout-watch`、`tui-watch`。
- 不要再把实现路径、历史兼容名、hooks/legacy 细分写进 `agentId`。
- `source` 已从规范字段删除；后续判断和显示都只允许基于 `agentId + entryPointId`。

## 通道职责拆分

| 通道 | 能稳定拿到 | 拿不到 / 不应假设能拿到 | 适合承担的职责 |
| --- | --- | --- | --- |
| Codex legacy `notify` | `agent-turn-complete` 对应的一次性 completion payload，以及它触发当场可直接探测到的终端上下文 | `PermissionRequest`、`InputRequest` | 正常 `Stop` 通知 |
| Codex hooks `hooks.json` | 官方 `session_id` / `turn_id`、hook 事件名、当前 `cwd`、`SessionStart.source` | rollout / TUI 历史中的后续 `InputRequest` | `SessionStart` bootstrap，以及 `PermissionRequest` / `Stop` 官方通知 |
| `codex-session-watch` | rollout JSONL、`codex-tui.log`、`sessionId`、`turnId`、`cwd` | 官方 hooks 直接提供的 terminal 上下文 | `InputRequest` 双来源检测与发送 |

## 当前数据流

```text
Stop:
  Claude Stop / Codex legacy notify / Codex hooks Stop
    └─ ai-agent-notify
         ├─ normalizeIncomingNotification()
         ├─ 归一化为 agentId + entryPointId
         ├─ 采 terminal context
         └─ 直接做 notify.ps1 dispatch

PermissionRequest:
  Claude PermissionRequest / Codex hooks PermissionRequest
    └─ ai-agent-notify
         ├─ normalizeIncomingNotification()
         ├─ 归一化为 agentId + entryPointId=hooks-mode
         ├─ 采 terminal context
         └─ 直接做 notify.ps1 dispatch

InputRequest:
  Codex session start
    └─ Codex hooks SessionStart
         └─ ai-agent-notify
              ├─ 记录精确 `sessionId -> terminal context`
              └─ 确保 `codex-session-watch` 已运行

  Later request_user_input
    └─ codex-session-watch
         ├─ 读 rollout JSONL
         ├─ 读 codex-tui.log
         ├─ 归一化为 InputRequest
         ├─ 用 sessionId 做精确 terminal context 命中
         └─ 命中失败时退回 neutral fallback
         └─ 发 notify / flash / open / tab hint
```

## 为什么这样拆

### 为什么默认入口要同时兼容 stdin / argv / hooks

Claude Code 的 hook 习惯是把 JSON 通过 stdin 传进来；Codex 旧版 `notify` 把 JSON payload 作为 argv 传给命令；Codex 官方 hooks 也会直接起本地命令。当前项目把这些 transport 统一收口到 `normalizeIncomingNotification()`，这样对外只需要一个命令名 `ai-agent-notify`，不必为 Claude / Codex 维护多套入口。

### 为什么 `InputRequest` 还保留 watcher

当前官方 Codex hooks 已经有 `SessionStart`，但 `InputRequest` 仍需要依赖本地 rollout JSONL 和 `codex-tui.log`。因此 watcher 只保留这一条职责，不再承担 approval 或 completion 的补救逻辑。

### 为什么 direct notify 现在保持单进程

因为用户现在选择把“UI 最多等多久”完全交给 Codex `hooks.json` 的 `timeout`。这样 CLI 内部可以保持单进程，不再维护额外进程、payload 文件和额外入口；terminal 探测、即时 WT tab 提示和 `notify.ps1` dispatch 都留在同一个进程里完成，`InputRequest` watcher 的拉起则由 `SessionStart` 单独负责。

### 为什么 `SessionStart` 现在承担 bootstrap

`SessionStart` hook 同时拿得到官方 `session_id` 和本地当前终端附着关系，所以不再需要先写一条“未对账 observation”，再由 watcher 事后 reconcile。这样 `InputRequest` 定位链可以直接收敛成“精确 session 命中，否则中性降级”。

## 核心代码入口

| 主题 | 主要文件 |
| --- | --- |
| CLI 总入口与模式分发 | [`../bin/cli.js`](../bin/cli.js) |
| notify / hooks / legacy payload 收口 | [`../lib/notification-source-parsers.js`](../lib/notification-source-parsers.js) |
| 通知 runtime 与日志 | [`../lib/notify-runtime.js`](../lib/notify-runtime.js) |
| 终端上下文探测 | [`../lib/notify-terminal-context.js`](../lib/notify-terminal-context.js) |
| `SessionStart` hook bootstrap | [`../lib/codex-session-start-hook.js`](../lib/codex-session-start-hook.js)、[`../lib/codex-terminal-context-store.js`](../lib/codex-terminal-context-store.js) |
| watcher 主循环 | [`../lib/codex-session-watch-runner.js`](../lib/codex-session-watch-runner.js) |
| rollout 文件扫描与 metadata | [`../lib/codex-session-watch-files.js`](../lib/codex-session-watch-files.js) |
| watcher 事件流处理 | [`../lib/codex-session-watch-streams.js`](../lib/codex-session-watch-streams.js)、[`../lib/codex-session-watch-handlers.js`](../lib/codex-session-watch-handlers.js) |
| watcher 定位与通知发送 | [`../lib/codex-session-watch-notify.js`](../lib/codex-session-watch-notify.js) |

## 下一步阅读

- [Codex hooks、InputRequest watcher 与 `SessionStart`](./codex-approval.md)
- [Windows 运行时与通知实现](./windows-runtime.md)
- [历史与实测归档](./history/README.md)
