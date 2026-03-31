# 架构与职责边界

这一页只记录当前仍成立的总体架构、通道边界和平台约束。带日期的实验、机器相关结论与排障过程统一放到 [`history/`](./history/)。

## 当前结论

- 默认入口 `claude-code-notify` 同时收口 Claude hook stdin、Codex legacy notify argv 和 wrapper 注入的 env payload。
- completion 继续走 `notify` 直达，不走 sidecar 这条链。
- approval 由 `codex-session-watch` 识别，`codex-mcp-sidecar` 只补启动期 terminal context；两者职责故意分开。

## 架构

```text
Default notify mode (Claude hook stdin JSON / Codex notify argv JSON / wrapper env JSON)
  → bin/cli.js
      ├─ normalizeIncomingNotification()
      ├─ 建 log 文件: %TEMP%\claude-code-notify\session-<id>.log
      ├─ detectTerminalContext()
      │    ├─ scripts/find-hwnd.ps1 -IncludeShellPid
      │    ├─ scripts/get-shell-pid.ps1
      │    └─ 父链 shell pid 回退
      ├─ Windows Terminal: 直接写 OSC + 启动 tab watcher
      └─ scripts/notify.ps1

Codex MCP sidecar
  → bin/cli.js codex-mcp-sidecar
      ├─ 继承 process.cwd() 作为真实项目目录
      ├─ 记录启动期 hwnd / shellPid / isWindowsTerminal
      ├─ 扫描 rollout 反推最可能的 sessionId
      └─ 兜底启动 codex-session-watch
```

### 为什么默认入口要同时兼容 stdin / argv / env

Claude Code 的 hook 习惯是把 JSON 通过 stdin 传进来；Codex 旧版 `notify` 则把 JSON payload 作为最后一个 argv 追加给命令。Windows wrapper 场景下，还会有“先收 payload、再改走 env 转运”的需求。当前项目把三种 transport 统一收口到 `normalizeIncomingNotification()`，这样对外只需要一个命令名 `claude-code-notify`，不必为 Claude / Codex 维护多套入口。

## 官方约束

- 官方文档当前只把 `notify` 定义为“Codex 在支持的事件上启动一个外部程序，并给它传一个 JSON 参数”。
- 官方文档当前明确说 `notify` 只覆盖 `agent-turn-complete`。
- 官方文档把 `approval-requested` 放在 `tui.notifications` 这一组能力下，而不是 `notify`。
- `tui.notification_method` 只是控制 TUI 自己发 `osc9` / `bel`。
- `features.codex_hooks` 在 config reference 里仍是 under development / off by default，当前没有公开 lifecycle hook 文档可用于主路线设计。

## 提醒 + 定位的职责拆分

### 通道能力矩阵

| 通道 | 能稳定拿到 | 拿不到 / 不应假设能拿到 | 适合承担的职责 |
| --- | --- | --- | --- |
| `codex-mcp-sidecar` | session 启动时机、继承的 `cwd`、本机父进程链、可自行探测的 `hwnd` / `shellPid` | 启动瞬间的官方 `sessionId`、`threadId`、`turnId`、approval 事件、官方 tab id | approval 场景的启动期终端线索、兜底拉起 watcher |
| Codex legacy `notify` | 一次性 completion payload，常见场景下的 `thread-id` / `turn-id` / `cwd`，以及它触发当场可直接探测到的终端上下文 | approval 请求 | 完成类通知 + completion 当场定位 |
| `codex-session-watch` | rollout `sessionId`、approval event、`cwd`、TUI 里的早期 approval 线索 | 启动当场的终端句柄、原始 tab 句柄 | approval 检测 + 提醒触发 |

### 当前项目里的真实数据流

```text
Completion:
  Codex turn complete
    ├─ 触发 legacy notify
    ├─ claude-code-notify 当场解析 completion payload
    ├─ cli.js 直接探测当前终端上下文
    └─ notify.ps1 发 toast / flash / open

Approval:
  Codex session start
    ├─ 自动拉起 codex-mcp-sidecar
    │    ├─ 读取继承到的 cwd
    │    ├─ 在本机父链里找 shellPid / hwnd
    │    ├─ 若 watcher 未运行则隐藏拉起 codex-session-watch
    │    └─ 把“启动期终端线索”写到 sidecar state
    └─ 后续真正发生 approval
         ├─ rollout JSONL / codex-tui.log 被 codex-session-watch 看到
         ├─ watcher 得到 sessionId / approvalKind / turnId 等语义线索
         ├─ watcher 按 sessionId 查询 sidecar state
         │    ├─ 命中: 复用保存下来的 hwnd / shellPid 做定位增强
         │    └─ 未命中: 退回 neutral Toast-only
         └─ notify.ps1 发 toast / flash / open
```

completion 不走 sidecar 这条链。只有 approval 的提醒触发与定位，才是 `codex-session-watch + codex-mcp-sidecar` 的组合结果。

### 为什么 hwnd 查找在 Node 侧

VSCode/Cursor 集成 git bash 场景下，MSYS2 bash fork 会断开 PowerShell 自身的父进程链，但 `node.exe` 是纯 Win32 进程，其父链完整，因此在 Node 侧做 `hwnd` / `shellPid` 查找更可靠。

## 相关历史

- [Codex notify 实测结论](./history/codex-notify-findings.md)
- [Windows Terminal Tab 颜色演进](./history/tab-color-history.md)
