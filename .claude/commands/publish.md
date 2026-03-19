---
description: 发布 claude-code-notify 包到 npm。用法：/publish
allowed-tools: Bash, Read, Edit
---

发布 `packages/claude-code-notify`。

**重要原则：每个步骤执行后立即检查结果。一旦遇到任何错误、异常或需要决策的情况，不要自行修复或假设，使用 AskUserQuestion 工具向用户说明情况并询问如何处理，等待用户回复后再继续。如果用户未作出明确指示，立即中断，不要继续后续步骤。**

按以下步骤执行：

## 步骤 1：检查工作区状态

运行 `git status`，确认没有未提交的改动。如果有未提交文件，停止并提示用户先处理。

## 步骤 2：展示自上次发布以来的改动

```bash
git log --oneline $(git describe --tags --match "notify-v*" --abbrev=0)..HEAD -- packages/claude-code-notify/
git diff $(git describe --tags --match "notify-v*" --abbrev=0)..HEAD -- packages/claude-code-notify/
```

## 步骤 3：判断版本类型并 Bump 版本号

根据步骤 2 的 git log 和 diff，按语义化版本规则自行判断应使用 patch / minor / major：

- **patch**：仅 bug 修复、文档更新、配置调整等不影响功能的改动
- **minor**：新增功能，但向后兼容
- **major**：破坏性变更（breaking change）

如果无法确定，使用 AskUserQuestion 工具说明原因并询问用户。

读取 `packages/claude-code-notify/package.json`，计算新版本号后更新 `version` 字段。

## 步骤 4：发布到 npm

```bash
cd packages/claude-code-notify && npm publish --access=public
```

## 步骤 5：Git commit

运行 `git status`，根据实际改动生成拟提交的文件列表和 commit message，使用 AskUserQuestion 展示给用户确认。用户同意后执行，不同意则重新生成方案再次确认。

## 步骤 6：打 tag

```bash
git tag notify-vX.X.X
```

## 步骤 7：Push

```bash
git push
git push --tags
```

## 步骤 8：输出发布摘要

输出本次发布的摘要，包括：版本号、发布时间、主要变更。
