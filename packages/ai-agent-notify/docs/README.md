# 文档总览

改代码、改默认路线、改文档结构前，先看 [`principles.md`](./principles.md)。

## 当前主线

- 用户安装、最小配置和当前限制只放在 [`../README.md`](../README.md)。
- completion 通知继续走顶层 `notify` 直达。
- Codex hooks 负责 `SessionStart` / `PermissionRequest` / `Stop`。
- `SessionStart + codex-session-watch` 只为 `InputRequest` 输入提示保留。
- Windows direct process launch 语境下，命令名显式写 `ai-agent-notify.cmd` / `npx.cmd`。

## 开发与发布流程

- 不要直接在 `main` 上改 `ai-agent-notify`；先从 `main` 切功能分支。
- 向 `main` 提交 PR 时，由 [`ci-ai-agent-notify.yml`](../../../.github/workflows/ci-ai-agent-notify.yml) 跑 Windows 测试。
- PR 合并到 `main` 后，由 [`publish-ai-agent-notify.yml`](../../../.github/workflows/publish-ai-agent-notify.yml) 自动发布 npm、tag 和 GitHub Release。
- 仓库设置里应对 `main` 开启“必须通过 PR 合并”和“必须通过状态检查”。

## 建议阅读顺序

1. [`principles.md`](./principles.md)：先看哪些边界不能随手打破。
2. [`architecture.md`](./architecture.md)：再看项目目的、官方约束和总体职责拆分。
3. [`codex-approval.md`](./codex-approval.md)：需要理解 approval 路线时再展开。
4. [`windows-runtime.md`](./windows-runtime.md)：需要改 Windows 行为时再看运行时约束。
5. [`history/README.md`](./history/README.md)：只有在回溯旧方案、排障证据或机器特例时再看。

## 按改动类型进入

- 要改 completion 通知入口、payload 解析、基础通知流：先看 [`architecture.md`](./architecture.md) 和 [`windows-runtime.md`](./windows-runtime.md)，再看 [`../bin/cli.js`](../bin/cli.js)、[`../lib/notification-source-parsers.js`](../lib/notification-source-parsers.js)、[`../lib/notify-runtime.js`](../lib/notify-runtime.js)。
- 要改 Codex hooks、`InputRequest` watcher 或 session 定位语义：先看 [`codex-approval.md`](./codex-approval.md)，再看 [`../lib/codex-session-start-hook.js`](../lib/codex-session-start-hook.js)、[`../lib/codex-terminal-context-store.js`](../lib/codex-terminal-context-store.js)、[`../lib/codex-session-watch-runner.js`](../lib/codex-session-watch-runner.js)、[`../lib/codex-session-watch-notify.js`](../lib/codex-session-watch-notify.js)。
- 要改 Windows 窗口定位、图标、任务栏闪烁、WT tab 颜色：直接看 [`windows-runtime.md`](./windows-runtime.md)，再看 [`../lib/notify-terminal-context.js`](../lib/notify-terminal-context.js)、[`../scripts/notify.ps1`](../scripts/notify.ps1)、[`../scripts/start-tab-color-watcher.ps1`](../scripts/start-tab-color-watcher.ps1)、[`../scripts/tab-color-watcher.ps1`](../scripts/tab-color-watcher.ps1)。
- 要判断某条旧路线是否已经被否决：先看 [`history/README.md`](./history/README.md)，不要直接从旧实验结论反推当前默认方案。

## 文档分层

- [`../README.md`](../README.md)：只放面向用户的安装、配置、限制和最小示例。
- [`principles.md`](./principles.md)：只放不能轻易打破的约束。
- [`architecture.md`](./architecture.md)：只放根本需求、官方边界和长期职责拆分。
- [`codex-approval.md`](./codex-approval.md)：只放当前仍生效的 Codex hooks、`InputRequest` watcher 和 `SessionStart` bootstrap 语义。
- [`windows-runtime.md`](./windows-runtime.md)：只放当前仍生效的 Windows 运行时约定。
- [`history/`](./history/)：只放带日期、带机器前提、带试错过程的归档。
