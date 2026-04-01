# Codex Notify 实测结论

这一页只收纳带日期、带机器环境前提、或明显偏排障视角的结论。当前生效的架构与实现，请回到 [`../architecture.md`](../architecture.md)、[`../codex-approval.md`](../codex-approval.md) 和 [`../windows-runtime.md`](../windows-runtime.md)。

## 2026-04-01: 当前本机的 `npx` 路线恢复正常，但原因未定位

### 现象

本机当前重新验证后，下面这组配置已经能正常工作：

- `notify = ["npx.cmd", "@erica-s/ai-agent-notify"]`
- `[mcp_servers.ai_agent_notify_sidecar]`
  - `command = "npx.cmd"`
  - `args = ["@erica-s/ai-agent-notify", "codex-mcp-sidecar"]`
  - `startup_timeout_sec = 30`

当前观察里，completion notify、sidecar 启动、以及后续窗口 / tab 定位增强都没有再出现之前那批 `npx` 问题。

### 结论

- 当前 README 重新把 `npx` 作为默认 public guidance。
- 主要原因不是“它一定比全局安装更稳定”，而是它能自动拿到最新发布版本，日常使用成本更低。
- 但这次恢复正常的根因暂时没有定位清楚，所以它仍然只是一条“当前本机可用”的结论，不等于把 2026-03-31 的历史问题从根上推翻了。

### 当前影响

- 当前 public config 默认写 `npx.cmd @erica-s/ai-agent-notify`。
- sidecar 的 `startup_timeout_sec` 同步放宽到 `30`，给 `npx` 额外启动链留余量。
- 如果别的机器再次出现 `os error 206`、Toast-only 退化、或 sidecar 启动超时，优先回退到全局安装直启方案再继续排查。

## 2026-03-31: Windows completion notify 启动链并不跨机器稳定

### 现象

在 Windows 上，Codex completion 的 legacy `notify` 启动链会同时受到两类因素影响：

- shim / launcher 如何转发长 JSON argv
- `notify` 进程在运行当场还能不能回溯到原始 terminal context

### 结论

- `notify = ["npx.cmd", "@erica_s/claude-code-notify"]` 不稳定。
  - completion 的整段 JSON payload 直接作为 argv 传给 notify 命令时，Windows 可能命中命令行长度 / 重解析问题。
  - 典型报错是 `The filename or extension is too long. (os error 206)`。
- `notify = ["npx", "@erica_s/claude-code-notify"]` 也不应作为默认方案。
  - 在某些机器上，`Get-Command npx` 命中的是 `npx.ps1`，与 `npx.cmd` 的行为并不等价。
  - 即使它能启动，也仍沿用同一条“长 JSON argv”链路，不能从根上解决 `os error 206`。
- `notify = ["claude-code-notify"]` 与 `notify = ["claude-code-notify.cmd"]` 也不是普适答案。
  - 裸命令名可能直接命中 `program not found`
  - 显式 `.cmd` 只能修复 command resolution，不能修复长参数传递
- `wscript.exe + %LOCALAPPDATA%\claude-code-notify\codex-notify-wrapper.vbs` 能工作，但它要求用户在 `config.toml` 中写绝对路径，不适合作为“像正常 npm 包一样无感使用”的最终方案。

### 当前影响

- `npx*` 入口在 Windows 上不应被视为跨机器稳定方案。
- 即使 toast 能发出来，额外的 `npx` / shim / launcher 链也可能让 `hwnd` / `shellPid` 恢复退化成 Toast-only，从而影响 taskbar flash、`Open` 和 Windows Terminal tab 高亮。
- 当前活跃文档只保留这层结论，不再把整段实测过程混入主设计文档正文。

## 2026-03-31: 超长会话会放大 legacy notify argv 风险

### 现象

本机实测里，一个持续约 15 天、一直未 `clear` 的 Codex 会话开始稳定触发同样的 `os error 206`；执行 `clear` 后，在新会话里同样配置立即恢复正常。

### 结论

- 问题不只是某个 shim 名称写法不对，也和会话累计后的 completion payload 体积有关。
- 会话越长，越容易把 Windows 这条 argv 链路打爆。

### 当前影响

- README 保留这一条作为当前限制说明。
- 更细的机器实测细节只保留在历史页，不再混进活跃架构文档。

## 2026-03-27: approval 的第二条线当前仍不能删

### 现象

对真实 approval 的 watcher 日志复看后，最近几次真正弹出来的 approval 通知，主要命中的仍是：

- `ToolCall: shell_command ... require_escalated`
- `queued approval pending`
- grace 窗口结束后 `pending event matched`

也就是说，这些案例实际走的是 `TUI fallback -> pending -> emit`，而不是 rollout 结构化 `response_item.function_call` 的 immediate 分支。

### 结论

- 现在不是两套彼此独立的提醒系统，而是两个信号源：
  - rollout structured signal
  - TUI fallback signal
- 如果只保留 rollout immediate，这批真实 approval 会直接漏掉。

### 当前影响

- 活跃设计文档中继续保留 rollout 优先，但不会删除 TUI fallback。
- 后续优化方向是缩短 pending 体感延迟、解释为什么某些真实 approval 没命中 rollout immediate，而不是简单删掉第二条线。

## 当前默认含义

- 默认 completion 路线、approval 路线与 Windows runtime 细节，见活跃文档。
- 历史页只保存“为什么今天的结论会是这样”的证据链，不负责定义当前 public guidance。
