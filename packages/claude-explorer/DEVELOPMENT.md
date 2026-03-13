# claude-explorer 开发文档

## 架构

```
src/
  index.js     - 主入口，导出所有公开 API，包含 JSDoc typedef
  reader.js    - 底层 .jsonl 文件读取与解析
  projects.js  - 项目列举、slug 解码、getClaudeDir()
  sessions.js  - 会话列举与元数据提取
  messages.js  - 消息解析与搜索
test/
  smoke.js     - 手动冒烟测试
```

## 设计决策

### 为什么是 CommonJS 而非 ESM？

与同仓库的 `claude-code-notify` 保持一致，均为 CommonJS。且此库定位为脚本工具依赖，CommonJS 兼容性更广（Node 16+）。

### 为什么是只读 API？

此库定位是读取本地会话用于检索/分析，不应有写入副作用，避免意外损坏 Claude Code 数据。

### 容错策略

`readJsonl()` 对单行解析失败静默跳过。`listSessions()` 对整个会话文件处理失败也跳过。这样一个损坏的文件不会影响整体结果。

## Claude Code JSONL 格式

每行是一个独立的 JSON 对象，常见 `type` 值：

| type | 说明 |
|------|------|
| `user` | 用户消息或 tool_result |
| `assistant` | 助手消息（含 thinking、tool_use 等） |
| `file-history-snapshot` | 文件快照（噪音，过滤掉） |

`user` / `assistant` 记录的结构：

```js
{
  type: 'user' | 'assistant',
  uuid: '...',           // 本条消息 ID
  parentUuid: '...',     // 父消息 ID（根消息为 null）
  sessionId: '...',      // 会话 UUID
  timestamp: '...',      // ISO 8601
  cwd: '...',
  gitBranch: '...',
  version: '...',        // Claude 版本
  slug: '...',           // 可读会话名（仅在根消息中出现）
  message: {
    role: 'user' | 'assistant',
    content: string | ContentBlock[]
  }
}
```

`content` 有两种格式：
- **旧格式**：字符串（整个消息文本）
- **新格式**：`ContentBlock[]`，每块有 `type`（`text`、`thinking`、`tool_use`、`tool_result` 等）

`parseContent()` 将两种格式统一为 `ContentBlock[]`。

## slug 编码规则与解码局限

Claude Code 创建项目目录时，将工作目录路径编码为 slug：
- `:` → `-`（Windows 盘符后的冒号）
- 路径分隔符（`\` 或 `/`）→ `-`

例如：`D:\XAGIT\my-app` → `D--XAGIT-my-app`

**解码歧义**：`-` 既可能是路径分隔符，也可能是目录名中的字面连字符。`decodeSlug()` 实现：
1. 若以 `X--` 开头，还原为 `X:\`
2. 其余 `-` 全部视为路径分隔符

这对无连字符的目录名是正确的，对含连字符的目录名会产生错误拆分。这是格式本身的不可逆性，无法完美解决。如需精确工作目录，请读取会话的 `cwd` 字段。

## 会话元数据提取策略

- **slug / title**：从 `parentUuid === null` 的根 user 消息提取——只有根消息才有 `slug` 字段，且根消息的文本内容是整个会话的"起点问题"
- **cwd / gitBranch / version**：遍历所有记录取第一个非空值（所有记录均含这些字段）
- **startedAt / updatedAt**：遍历所有记录取最早/最晚 timestamp
- **hasSubagents**：检查同名无扩展名目录下是否有 `subagents/` 子目录

## 已知问题

**title 可能不是真实用户意图**：某些会话的根消息内容是由 plan 模式注入的完整计划文本（以 `Implement the following plan:` 开头），而非用户的原始问题。这是上游格式的特性。

**message 顺序为文件追加顺序**：`readSession()` 返回的消息按文件行顺序排列，不保证按 `timestamp` 或对话树顺序排序。如需按对话树遍历，需要自行根据 `parentUuid` 构建树结构。
