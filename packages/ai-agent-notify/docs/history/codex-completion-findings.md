# Codex Completion 实测结论

这一页只保留带日期、带机器前提的验证结果。它解释“为什么今天会收敛到这些约束”，但不负责定义当前默认配置；当前仍生效的 public guidance 和实现边界请回到 [`../README.md`](../README.md)、[`../architecture.md`](../architecture.md) 和 [`../windows-runtime.md`](../windows-runtime.md)。

## 先看仍有效的发现

- Windows direct process launch 下，命令名要显式写 `.cmd`；这是 command resolution 问题，不是 payload 长度问题。
- 超长会话会放大 legacy `notify` 的 argv 风险，真实出现过 `os error 206`。
- `npx` 路线曾在本机恢复可用，但根因没有定位清楚，因此它始终更像环境结论，而不是可脱离证据长期硬编码的默认假设。
- approval 这边并不是只靠 rollout immediate；真实命中里仍有旧界面日志 fallback 流量。

## 2026-04-01：Windows direct process launch 需要显式 `.cmd`

本机在 Volta 全局安装 `@erica-s/ai-agent-notify` 后，这两个名字并不等价：

- `ai-agent-notify`
- `ai-agent-notify.cmd`

在 shell 里手打命令时，两者都可能“看起来能跑”；但 `notify = [...]`、MCP `command = "..."` 这类 direct process launch 不一定经过 shell，`ai-agent-notify` 不能稳定命中 Windows cmd shim，而 `ai-agent-notify.cmd` 可以。

这条发现留下来的意义是：

- Windows direct process launch 语境下应显式写 `.cmd`
- 同理，`npx` 路线也应写 `npx.cmd`
- 不要把 `.cmd` 问题和长会话 / 大 payload 风险混成同一个故障

## 2026-03-31：超长会话会放大 legacy notify argv 风险

本机出现过一个持续约 15 天、一直未 `clear` 的 Codex 会话，之后 completion notify 稳定触发：

```text
The filename or extension is too long. (os error 206)
```

执行 `clear` 后，在新会话里同样配置立即恢复正常。

留下来的结论是：

- 会话越长，越容易把 Windows 这条 argv 链路打爆
- 这和 `.cmd` 是否写对是两个独立问题
- 这也是 README 里“Very long Codex sessions”限制仍然保留的原因

## 2026-04-01：`npx` 在本机恢复可用，但这不是永久性证明

同一台机器后续重新验证时，`npx.cmd` 路线又恢复正常，completion notify、sidecar 启动和定位增强都能工作。

这条记录保留下来的目的不是重新把 `npx` 定义成默认路线，而是提醒后续维护者：

- `npx` 是否稳定受机器环境影响
- 某一台机器“今天恢复正常”不等于根因已经查清
- 如果别的机器再次出现 completion / sidecar 异常，应优先回到活跃文档定义的当前路线，而不是直接拿这条历史记录反推默认配置

## 2026-03-27：approval 的第二条信号当前仍不能删

对真实 approval 的 watcher 日志复看后，最近几次真正弹出来的通知，主要命中的仍是：

- `ToolCall: shell_command ... require_escalated`
- `queued approval pending`
- grace 窗口结束后 `pending event matched`

也就是说，这批案例走的是：

- rollout structured signal
- 旧界面日志 fallback signal

这里说的“旧界面日志 fallback”是当时旧 watcher 仍消费的一条本地界面日志链路；它只是在描述当时的历史信号，不代表当前实现仍保留这条路径。

而不只是 rollout 结构化 `response_item.function_call` 的 immediate 分支。

所以这页保留的核心结论是：

- approval 不是单一信号源
- 如果只保留 rollout immediate，这批真实 approval 会直接漏掉
- 活跃设计文档可以继续定义“rollout 优先”，但不能据此误写成“旧界面日志 fallback 当时已经没流量了”

## 2026-04-02：旧的 Desktop / VSCode 起源线程接到 CLI 后仍可能不触发 completion notify

同机对照里，`notify` 是否触发，不只取决于当前是不是“在 CLI 里继续聊”，还取决于这条线程最初是怎么创建的：

- 新开的 CLI 原生线程：`session_meta` 原始字段值显示 `originator = "codex-tui"`、`source = "cli"`，completion notify 可正常触发
- 旧的 Desktop / VSCode 起源线程：`session_meta` 显示 `originator = "Codex Desktop"`、`source = "vscode"`；即使后续在 CLI 里继续，这条线程最近多次 `tasks: close` 后仍没有看到 Codex 自动调用 `notify`

同轮排障里还排除了另一个独立问题：

- `C:\Users\Erica\ai-agent-notify.cmd` 曾被错误内容遮蔽
- 删除该脏文件后，命令本身恢复正常，但旧线程仍然不触发 notify

因此这条记录的价值在于：

- 区分“本地命令遮蔽”与“旧线程不触发 notify”这两个问题
- 提醒后续维护者不要把这类 thread-origin 差异误判成普通的命令解析故障
