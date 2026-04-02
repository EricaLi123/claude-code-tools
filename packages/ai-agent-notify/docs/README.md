# 文档总览

改代码或改文档前，先看 [`principles.md`](./principles.md)。

`ai-agent-notify` 的文档分成五层：

- [`principles.md`](./principles.md)：给开发者和 AI 的硬约束，定义什么不能乱改。
- `README.md`：给使用者看的最小安装、配置和限制说明。
- 活跃设计文档：记录当前仍生效的需求、架构、方案和取舍。
- 开发维护文档：记录这套文档应该怎么更新，避免内容放错地方。
- `history/`：记录已经遇到过的问题、试过的方案、结果和原因，避免重复踩坑。

## 先看当前主线

- completion 通知继续走顶层 `notify` 直达。
- approval 通知继续走 `codex-session-watch + codex-mcp-sidecar`。
- README 当前公开推荐“先安装包，再用 `ai-agent-notify.cmd` 直配命令”。
- Windows 下如果配置项属于 direct process launch，命令名显式写 `.cmd`。

## 阅读顺序

1. [`principles.md`](./principles.md)：先看不能乱改什么。
2. [`architecture.md`](./architecture.md)：再看根本需求、长期方向和职责边界。
3. [`codex-approval.md`](./codex-approval.md)：看 Codex approval 当前怎么做、为什么这样做。
4. [`windows-runtime.md`](./windows-runtime.md)：需要改 Windows 行为时再看运行时约束和兼容性方案。
5. [`history/`](./history/)：只有在要改现有方案、怀疑回到旧坑、或需要看排障证据时再展开。

## 文档分工

- [`principles.md`](./principles.md)：记录开发者和 AI 必须先遵守的产品原则与文档原则。
- [`architecture.md`](./architecture.md)：记录根本需求、总体架构和长期不想打破的边界。
- [`codex-approval.md`](./codex-approval.md)：记录 approval 这条线当前采用的方案、配置和原因。
- [`windows-runtime.md`](./windows-runtime.md)：记录 Windows 运行时约束、兼容性问题和当前采用方案。
- [`development.md`](./development.md)：记录开发时如何更新这些文档，防止信息散掉。
- [`history/`](./history/)：记录历史问题、试错路径、采用结果和原因。

## 更新时放哪里

- 用户安装方式、最小配置、当前限制：写到 [`../README.md`](../README.md)。
- 当前仍生效的架构、配置、实现约束：写到活跃设计文档。
- 带日期、带机器前提、带排障过程、已经否决的路线：写到 [`history/`](./history/)。

## 相关入口

- [架构与职责边界](./architecture.md)
- [开发原则](./principles.md)
- [Codex approval 检测与定位](./codex-approval.md)
- [Windows 运行时与通知实现](./windows-runtime.md)
- [历史与实测归档](./history/README.md)
