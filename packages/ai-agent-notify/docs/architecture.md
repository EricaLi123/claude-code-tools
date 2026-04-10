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
- completion 继续走 `notify` 直达，保持 notify-first；`codex-session-watch` 只在 matching completion receipt 仍缺失时做 delayed fallback。
- approval 继续由 `codex-session-watch` 识别，`codex-mcp-sidecar` 只负责记录启动期 terminal observation 和兜底拉起 watcher。
- `sessionId -> terminal context` 的解释权收口在 watcher，而不是 sidecar。

## 官方约束

- 官方文档当前只把 `notify` 定义为“Codex 在支持的事件上启动一个外部程序，并给它传一个 JSON 参数”。
- 官方文档当前明确说 `notify` 只覆盖 `agent-turn-complete`。
- 官方文档把 `approval-requested` 放在 `tui.notifications` 这一组能力下，而不是 `notify`。
- `tui.notification_method` 只是控制 TUI 自己发 `osc9` / `bel`。
- `features.codex_hooks` 在 config reference 里仍是 under development / off by default，当前没有公开 lifecycle hook 文档可用于主路线设计。

## 通道职责拆分

### 能力矩阵

| 通道 | 能稳定拿到 | 拿不到 / 不应假设能拿到 | 适合承担的职责 |
| --- | --- | --- | --- |
| `codex-mcp-sidecar` | session 启动时机、继承的 `cwd`、本机父进程链、可自行探测的 `hwnd` / `shellPid` | 启动瞬间的官方 `sessionId`、`threadId`、`turnId`、approval 事件、官方 tab id | approval 场景的启动期 terminal observation、兜底拉起 watcher |
| Codex legacy `notify` | 一次性 completion payload，常见场景下的 `thread-id` / `turn-id` / `cwd`，以及它触发当场可直接探测到的终端上下文 | approval 请求 | 正常 completion 通知 + completion receipt |
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
