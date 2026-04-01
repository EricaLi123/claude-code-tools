# 开发说明

这一页只说明“开发时如何维护文档”。当前方案本身请从 [仓库 README](../README.md)、[文档总览](./README.md) 和 [开发原则](./principles.md) 进入，不在这里重复展开。

## 这套文档要解决什么

- 把根本需求、长期方向和当前方案分开，避免临时 workaround 反过来污染主设计。
- 把问题、试错、结果和原因单独留档，避免未来再次走回已经验证失败的路线。
- 让用户文档保持最小配置；让开发文档保留真正影响维护和演进的背景。

## 更新规则

- 改代码、改默认路线、改文档分工前，先读 [`principles.md`](./principles.md)。
- `README` 只保留安装、配置、常用命令和面向使用者的限制说明。
- 根本需求、长期边界、官方能力约束：写到 [`architecture.md`](./architecture.md)。
- 当前仍生效的方案、配置和设计原因：写到 [`codex-approval.md`](./codex-approval.md) 或 [`windows-runtime.md`](./windows-runtime.md)。
- 带日期、带机器环境前提、排障过程、被否决的方案：写到 [`history/`](./history/)。
- 面向使用者的安装、最小配置、当前限制：只写到 [`../README.md`](../README.md)。

## 变更时的落文档顺序

1. 先判断这次改动属于“需求 / 当前方案 / 历史问题”的哪一类。
2. 先确认这次改动有没有碰到 [`principles.md`](./principles.md) 里的硬约束。
3. 如果用户配置或默认 public guidance 变了，先更新 [`../README.md`](../README.md)。
4. 如果当前仍生效的设计变了，再更新对应的活跃设计文档。
5. 如果这次改动来自真实排障、试错或环境特例，再补到 [`history/`](./history/)。

## 历史文档的写法

历史文档不只是记录“发生了什么”，还要尽量回答这四件事：

- 遇到过什么问题
- 试过什么方案
- 最终采用或放弃了什么
- 为什么这样取舍

## 当前入口

- [文档总览](./README.md)
- [开发原则](./principles.md)
- [架构与职责边界](./architecture.md)
- [Codex approval 检测与定位](./codex-approval.md)
- [Windows 运行时与通知实现](./windows-runtime.md)
- [历史与实测归档](./history/README.md)
