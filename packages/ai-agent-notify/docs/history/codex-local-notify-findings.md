# Codex notify / completion 本地发现

这一页只归档本机这轮排查里确认过的本地问题。

- 主体是本地现象、归因和当前产品侧处理
- `openai/codex` issue 只作为附带信息放在最后，不主导这页结构

它不负责定义当前默认配置。活跃约束和实现边界仍以 [`../README.md`](../README.md)、[`../architecture.md`](../architecture.md)、[`../codex-approval.md`](../codex-approval.md) 和 [`../windows-runtime.md`](../windows-runtime.md) 为准。

相关实测细节见 [`./codex-completion-findings.md`](./codex-completion-findings.md)。

## 截止时间

- 本地归档更新到：2026-04-16
- 附带 issue 状态核对到：2026-04-16

## 本地确认过的三类 completion 失联

### 1. Windows direct process launch 下未显式写 `.cmd`

本地结论：

- 这是 command resolution 问题，不是 payload 长度问题
- `notify = [...]`、MCP `command = "..."` 这类 direct process launch 在 Windows 上不能把裸命令名 `ai-agent-notify` 当成稳定配置
- 同理，`npx` 路线也不能把裸命令名 `npx` 当成稳定配置

当前产品侧处理：

- 文档和配置约定里显式使用 `ai-agent-notify.cmd`
- `npx` 路线显式使用 `npx.cmd`

### 2. 超长会话触发 legacy `notify` argv 过长

本地结论：

- 这是 Windows argv transport 风险
- 长会话会放大 completion payload 体积
- Codex legacy `notify` 把 JSON 当最后一个 argv 追加时，可能在调用阶段直接失败
- 本机真实出现过 `The filename or extension is too long. (os error 206)`

当前产品侧处理：

- 不试图在本仓库里根治上游 transport
- completion 主路径仍走 direct notify
- watcher 侧通过 completion receipt + delayed fallback 兜底
- 实操上，如果命中这类长会话问题，`clear` 或新开会话仍是有效缓解

### 3. turn 已完成，但 Codex 没有触发 legacy `notify`

本地结论：

- 这次排查里的坏案例不是 `.cmd` 问题
- 也不是这次 payload 过长触发的 `206`
- 也不能简单归因为 `resume`
- 当前最强假设是某一类旧线程 lineage 的 silent skip
- 已确认“不是所有旧线程都会这样”，更像某些 `originator = "codex_cli_rs"` 的旧 CLI 线程在新版本运行时仍可能跳过 `legacy_notify`

当前产品侧处理：

- 继续把 direct notify 当 completion 主路径
- watcher 看到 rollout `task_complete` 后先等 grace 窗口
- grace 结束后如果 completion receipt 仍缺失，才补发 fallback completion 通知

## 当前收敛

- 本地至少确认了三类不同问题：`.cmd` 命令解析、Windows argv 过长、silent skip
- 这三类不是同一个故障，不应混在一起归因
- 当前产品方案的核心不是“等上游修好”，而是 direct notify 主路径配合 receipt + watcher delayed fallback 补齐失联

## 附：相关公开 issue

### 直接相关度最高

- `argv / 206` 这一类没有找到针对 `legacy_notify` 的同款公开 issue
- 目前最接近的是 [#15003](https://github.com/openai/codex/issues/15003) `Windows: apply_patch fails for large patches because patch body is still transported via argv`，状态 `Open`
- 这说明上游确实存在同类 Windows argv transport 风险，但公开 issue 落点在 `apply_patch`，不是 `notify`

### 周边但不等价

下面这些 issue 和 `notify`、approval、completion 通知能力相关，但不能替代本地这三类问题的单独归因：

- [#4491](https://github.com/openai/codex/issues/4491) `Feature request: built-in notifications for CLI responses`
- [#4998](https://github.com/openai/codex/issues/4998) `Feature Request: Add native OS notification when long-running Codex CLI tasks complete`
- [#2961](https://github.com/openai/codex/issues/2961) `Add notification for command execution approval prompts`
- [#3247](https://github.com/openai/codex/issues/3247) `Support notify for user approval events`
- [#6024](https://github.com/openai/codex/issues/6024) `Missing event logs for approval-request`
- [#4954](https://github.com/openai/codex/issues/4954) `for notify feature, the "input_messages" does not update`
