# Codex Hooks、InputRequest 与定位

这一页是给开发者和 AI 的 Codex 通知主手册。它只记录当前仍生效的设计、约束和改动判断。带日期的实验和机器相关复盘统一放到 [`history/`](./history/)。

## 这页不负责什么

- 不负责 completion 通知总体路线，那是 [`architecture.md`](./architecture.md) 和 [`../README.md`](../README.md)。
- 不负责 Windows 图标、窗口探测和 WT tab watcher 的实现细节，那是 [`windows-runtime.md`](./windows-runtime.md)。
- 不负责保存带日期的排障过程，那是 [`history/`](./history/)。

## 先看结论

- Codex 官方 hooks 负责 `PermissionRequest` 和 `Stop`。
- `notify = ["ai-agent-notify.cmd"]` 继续作为 legacy `Stop` 主路径。
- watcher 只处理 `InputRequest`。
- `codex-mcp-sidecar` 只负责记录启动期 terminal observation 和确保 watcher 在跑。
- 定位优先级是：精确 `sessionId` 命中 > `projectDir` / `cwd` 窗口级回退 > neutral Toast-only。
- 拿不到足够证据时宁可降级，也不盲猜 tab。

## 当前配置事实

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

官方 hooks：

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          { "type": "command", "command": "ai-agent-notify.cmd", "timeout": 2 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "ai-agent-notify.cmd", "timeout": 2 }
        ]
      }
    ]
  }
}
```

- Codex 当前会跳过带 `async: true` 的 hooks，所以 command hook 这里要写同步形式。
- Codex 当前 command hook 也是同步执行的，UI 会等待 hook 进程退出。
- 当前方案不再拆父子程序；如果不想 UI 等完整个通知流程，就直接在 `hooks.json` 给 hook 配 `timeout`，当前建议值是 `2` 秒。
- 只写 `hooks.json` 不够，`config.toml` 里还要显式打开 `codex_hooks = true`。
- `InputRequest` 目前不走官方 hooks；watcher 只处理 `InputRequest`。
- `codex-mcp-sidecar` 会在 session 启动期 auto-start `codex-session-watch`。

## 如果你要改 Codex 通知，先判断改的是哪一层

| 你要改的东西 | 应先看什么 | 当前 owner |
| --- | --- | --- |
| `PermissionRequest` / `Stop` 的官方输入 | hooks payload、归一化字段 | `notify-mode` + `hooks-mode` |
| `InputRequest` 怎么被发现 | rollout JSONL / `codex-tui.log` 双来源 | `codex-session-watch` |
| `sessionId -> terminal` 怎么解释 | sidecar observation + watcher reconcile | `codex-session-watch` |
| session 启动时记录什么终端线索 | startup observation | `codex-mcp-sidecar` |
| 通知如何落地到窗口 / tab | Windows 运行时 | [`windows-runtime.md`](./windows-runtime.md) |

## 当前数据流

```text
Stop / PermissionRequest
  → Codex legacy notify 或官方 hooks
      └─ ai-agent-notify
           ├─ normalizeIncomingNotification()
           ├─ 归一化为 agentId=codex
           ├─ legacy notify 记为 entryPointId=notify-mode
           ├─ 官方 hooks 记为 entryPointId=hooks-mode
           ├─ 采 terminal context
           └─ 直接做 notify.ps1 dispatch 与 watcher 启动

InputRequest
  → Codex session start
      └─ codex-mcp-sidecar
           ├─ 记录启动期 terminal observation
           └─ 确保 codex-session-watch 已运行

  → Later request_user_input
      └─ codex-session-watch
           ├─ 读 rollout JSONL
           ├─ 读 codex-tui.log
           ├─ 归一化为 InputRequest
           ├─ 先尝试精确 sessionId 定位
           ├─ 失败时再做 projectDir / cwd 窗口级 fallback
           └─ 发 notify / flash / open / tab hint
```

## 核心代码入口

| 主题 | 主要文件 |
| --- | --- |
| watcher 生命周期、单实例锁、build replace | [`../lib/codex-session-watch-runner.js`](../lib/codex-session-watch-runner.js) |
| rollout 扫描与元数据读取 | [`../lib/codex-session-watch-files.js`](../lib/codex-session-watch-files.js) |
| 增量消费 rollout / TUI | [`../lib/codex-session-watch-streams.js`](../lib/codex-session-watch-streams.js)、[`../lib/codex-session-watch-handlers.js`](../lib/codex-session-watch-handlers.js) |
| watcher 定位与通知发送 | [`../lib/codex-session-watch-notify.js`](../lib/codex-session-watch-notify.js) |
| sidecar reconcile / fallback 查找 | [`../lib/codex-sidecar-matcher.js`](../lib/codex-sidecar-matcher.js) |
| sidecar 启动期 observation 记录 | [`../lib/codex-mcp-sidecar-mode.js`](../lib/codex-mcp-sidecar-mode.js)、[`../lib/codex-sidecar-store.js`](../lib/codex-sidecar-store.js) |
| hooks / legacy payload 收口 | [`../lib/notification-source-parsers.js`](../lib/notification-source-parsers.js) |
| MCP 空 server 响应 | [`../lib/codex-mcp-server.js`](../lib/codex-mcp-server.js) |

## 为什么还是保留 sidecar

### 为什么不把 `InputRequest` 直接交给 hooks

当前官方 hooks 只接 `PermissionRequest` 和 `Stop`。`InputRequest` 还没有稳定的官方入口，所以仍要依赖 rollout JSONL 和 `codex-tui.log`。这也是 watcher 现在唯一保留的职责。

### 为什么 hooks-mode 现在走单进程

因为当前接受“Codex UI 通过 hook timeout 提前放行，进程本身是否跑完不由本包负责”这个边界，所以没必要继续维护额外进程。现在 hooks-mode 和 notify-mode 都直接走单进程通知路径；若要缩短 UI 等待，就改 `hooks.json` 的 `timeout`。

### 为什么 sidecar 不自己 resolve `sessionId`

为了把状态解释权收口到 watcher。当前 sidecar 只写启动期 observation：`cwd / hwnd / shellPid / startedAt`；由 watcher 在扫 rollout / `codex-tui.log` 时统一决定何时把 observation reconcile 成精确 `sessionId` 映射、何时只允许窗口级 fallback。

### 为什么 `mcp_servers.<id>.cwd` 仍然不要显式设置

sidecar 需要继承 Codex 当时的真实项目目录，才能把自己和后续 rollout 里的 `cwd` 对上。若把 MCP server 的 `cwd` 固定到包目录或别的路径，匹配就会失真，整个 `sessionId -> terminal` 归因链也就断了。

## 改完后至少检查什么

- 代码：确认 `PermissionRequest` / `Stop` 仍由 hooks / notify 直达，`codex-session-watch` 没有重新接回 approval 或 completion 逻辑。
- 文档：如果改了 hooks 边界、`InputRequest` watcher 或 sidecar 语义，更新本页和 [`architecture.md`](./architecture.md)。
- 测试：至少看 [`../test/specs/sidecar.test.js`](../test/specs/sidecar.test.js)、[`../test/specs/codex-events.test.js`](../test/specs/codex-events.test.js)、[`../test/specs/notification-and-docs.test.js`](../test/specs/notification-and-docs.test.js)、[`../test/specs/structure-and-runtime.test.js`](../test/specs/structure-and-runtime.test.js)。
