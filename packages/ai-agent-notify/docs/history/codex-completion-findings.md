# Codex Completion 实测结论

这一页只收纳带日期、带机器环境前提、或明显偏排障视角的结论。当前生效的架构与实现，请回到 [`../architecture.md`](../architecture.md)、[`../codex-approval.md`](../codex-approval.md) 和 [`../windows-runtime.md`](../windows-runtime.md)。

## 留档目的

- 解释为什么今天的 public guidance 和内部配置路线会是现在这样。
- 记录已经踩过的 Windows / Codex 组合坑，避免以后把独立问题重新混成一团。
- 给后续改配置、改 wrapper、改 approval 路线的人一个最短回溯入口。

## 先看当前结论

| 主题 | 当前判断 | 活跃文档 |
| --- | --- | --- |
| Windows public config | README 继续默认推荐 `npx.cmd @erica-s/ai-agent-notify` | [`../codex-approval.md`](../codex-approval.md) |
| Windows direct process launch | 显式写 `.cmd`；全局安装用 `ai-agent-notify.cmd`，`npx` 路线用 `npx.cmd` | [`../windows-runtime.md`](../windows-runtime.md) |
| 超长 Codex 会话 | 仍是已知限制；会放大 legacy `notify` 的长 argv 风险，和 `.cmd` 问题无关 | README，本页 |
| approval 检测 | rollout structured signal 和 TUI fallback signal 目前都不能删 | [`../codex-approval.md`](../codex-approval.md) |

## 问题 1：Windows direct process launch 的命令解析

### 2026-04-01: 全局安装路线在 Windows direct process launch 下应显式写 `.cmd`

本机在 Volta 全局安装 `@erica-s/ai-agent-notify` 后，Windows 下这两个名字并不等价：

- `ai-agent-notify`
- `ai-agent-notify.cmd`

在 shell 里手打命令时，两者都可能“看起来能跑”；但 `notify = [...]`、MCP `command = "..."` 这类 direct process launch 不一定经过 shell，`ai-agent-notify` 不能稳定命中到 Windows cmd shim，而 `ai-agent-notify.cmd` 可以。

采用方案与原因：

- 全局安装直配命令时，显式写 `ai-agent-notify.cmd`
- `npx` 路线同理，显式写 `npx.cmd`
- 这一类问题的本质是 command resolution，不是 long session，不是 payload 长度

## 问题 2：Windows completion 的 launcher / argv 链并不稳定

### 2026-03-31: Windows completion notify 启动链并不跨机器稳定

那轮排障里，`npx` 路线、裸命令名路线、显式 `.cmd` 路线、以及 `wscript.exe + vbs wrapper` 路线都做过实测；结论不是“某一条包打天下”，而是它们各自修复的问题不同：

- `npx.cmd` 主要解决 `npx` / `npx.ps1` 的命中差异
- 全局安装后显式写 `.cmd` 主要解决 direct process launch 下的 command resolution
- `wscript.exe + vbs wrapper` 主要解决 Windows 下 payload 转运与再次展开问题

同一轮排障里也确认了几件事：

- `notify = ["npx", "@erica_s/claude-code-notify"]` 不适合作为默认方案
- `notify = ["claude-code-notify"]` / `["claude-code-notify.cmd"]` 也不是普适答案
- 显式 `.cmd` 只能修复命令解析，不能替代 payload 转运方案

### 2026-03-31: 超长会话会放大 legacy notify argv 风险

本机实测里，一个持续约 15 天、一直未 `clear` 的 Codex 会话开始稳定触发 `The filename or extension is too long. (os error 206)`；执行 `clear` 后，在新会话里同样配置立即恢复正常。

采用方案与原因：

- 问题不只是某个 shim 名称写法不对，也和 completion payload 体积有关
- 会话越长，越容易把 Windows 这条 argv 链路打爆
- 这条限制应单独理解，不要和 `.cmd` 问题混为一谈

## 问题 3：`npx` 路线当前还能不能继续推荐

### 2026-04-01: 当前本机的 `npx` 路线恢复正常，但原因未定位

本机重新验证后，下面这组配置已经能正常工作：

```toml
notify = ["npx.cmd", "@erica-s/ai-agent-notify"]

[mcp_servers.ai_agent_notify_sidecar]
command = "npx.cmd"
args = ["@erica-s/ai-agent-notify", "codex-mcp-sidecar"]
required = false
startup_timeout_sec = 30
```

当前观察里，completion notify、sidecar 启动、以及后续窗口 / tab 定位增强都没有再出现之前那批 `npx` 问题。

采用方案与原因：

- README 继续把 `npx.cmd @erica-s/ai-agent-notify` 作为默认 public guidance
- 主要原因不是“它一定比全局安装更稳定”，而是它能自动跟上已发布版本
- 但这次恢复正常的根因暂时没有定位清楚，所以它仍然只是“当前本机可用”的结论
- 如果别的机器再次出现 `os error 206`、Toast-only 退化、或 sidecar 启动超时，优先回退到全局安装直启路线再继续排查

## 问题 4：approval 不是单一信号源

### 2026-03-27: approval 的第二条线当前仍不能删

对真实 approval 的 watcher 日志复看后，最近几次真正弹出来的 approval 通知，主要命中的仍是：

- `ToolCall: shell_command ... require_escalated`
- `queued approval pending`
- grace 窗口结束后 `pending event matched`

也就是说，这些案例实际走的是 `TUI fallback -> pending -> emit`，而不是 rollout 结构化 `response_item.function_call` 的 immediate 分支。

采用方案与原因：

- 现在不是两套彼此独立的提醒系统，而是两个信号源：
  - rollout structured signal
  - TUI fallback signal
- 如果只保留 rollout immediate，这批真实 approval 会直接漏掉
- 活跃设计文档继续保留 rollout 优先，但不删除 TUI fallback

## 简版时间线

- 2026-03-27: approval 侧先确认“第二条线不能删”
- 2026-03-31: completion 侧确认“Windows launcher / argv 链不稳定”，同时发现“超长会话会放大 `os error 206`”
- 2026-04-01: 进一步拆出“direct process launch 需要显式 `.cmd`”这一独立问题；同一天本机重新验证时 `npx.cmd` 路线恢复可用

## 这页对开发的意义

- `codex-approval.md` 负责定义“现在怎么配”
- `windows-runtime.md` 负责解释 Windows 直接起进程、wrapper 和 tab 高亮等运行时约束
- 本页只保留“为什么今天会收敛到这些结论”的证据链
