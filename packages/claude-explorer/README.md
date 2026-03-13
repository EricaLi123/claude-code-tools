# @erica_s/claude-explorer

读取、列举、搜索本地 Claude Code 数据的 Node.js 库。

Claude Code 的会话以 `.jsonl` 格式存储在 `~/.claude/projects/<project-slug>/` 下，文件名为 UUID，无法直接浏览。此库提供结构化 API，供脚本和工具使用。

## 安装

```bash
npm install @erica_s/claude-explorer
```

## API

```js
const sessions = require('@erica_s/claude-explorer');
```

### 项目相关

```js
// 列举所有项目
sessions.listProjects()
// => Project[]

// slug 解码工具（best-effort，见注意事项）
sessions.decodeSlug('D--XAGIT-foo')   // => "D:\XAGIT\foo"（Windows）
sessions.getClaudeDir()                // => "C:\Users\alice\.claude"
```

### 会话相关

```js
// 列举某项目的所有会话（按 updatedAt 倒序）
sessions.listSessions('D--XAGIT-my-project')
// => Session[]

// 列举全部项目的全部会话（按 updatedAt 倒序）
sessions.listAllSessions()
// => Session[]
```

### 消息与搜索

```js
// 读取某会话的完整消息列表（过滤掉 progress/system 等噪音）
sessions.readSession('D--XAGIT-my-project', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')
// => Message[]

// 关键词搜索（匹配 text 类型消息内容）
sessions.search('Claude Code', { project: 'D--XAGIT-my-project', limit: 10 })
// => Array<{ session: Session, matches: { role, text, timestamp }[] }>
```

## 数据结构

### Project

| 字段 | 类型 | 说明 |
|------|------|------|
| `slug` | string | 原始目录名，如 `D--XAGIT-my-project` |
| `path` | string | 解码后的路径（best-effort） |
| `sessionCount` | number | 该项目下的会话数量 |

### Session

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID（会话文件名，不含 `.jsonl`） |
| `projectSlug` | string | 所属项目 slug |
| `slug` | string? | 可读会话名，如 `stateful-stirring-lemur` |
| `cwd` | string? | 工作目录 |
| `gitBranch` | string? | Git 分支 |
| `version` | string? | Claude 版本号 |
| `startedAt` | string? | 第一条消息时间（ISO 8601） |
| `updatedAt` | string? | 最后一条消息时间（ISO 8601） |
| `messageCount` | number | user+assistant 消息总数 |
| `title` | string? | 根消息的 text 内容（截断到 80 字） |
| `hasSubagents` | boolean | 是否包含 subagents |

### Message

| 字段 | 类型 | 说明 |
|------|------|------|
| `uuid` | string | 消息 ID |
| `parentUuid` | string | 父消息 ID（根消息为 null） |
| `role` | `'user'`\|`'assistant'` | 角色 |
| `timestamp` | string | 时间（ISO 8601） |
| `content` | ContentBlock[] | 内容块数组 |
| `model` | string? | 模型名（assistant only） |
| `usage` | object? | Token 用量（assistant only） |

## 注意事项

**`decodeSlug` 有歧义**：Claude Code 使用 `-` 作为路径分隔符，目录名中的字面连字符与路径分隔符无法区分。例如 `D--XAGIT-claude-code-tools` 会被解码为 `D:\XAGIT\claude\code\tools` 而非 `D:\XAGIT\claude-code-tools`。如需精确路径，请读取会话记录中的 `cwd` 字段。

## 许可证

MIT
