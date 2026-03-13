'use strict';

/**
 * @typedef {Object} Project
 * @property {string} slug          - 原始目录名，如 "D--XAGIT-claude-code-tools"
 * @property {string} path          - 解码后的路径，如 "D:\XAGIT\claude-code-tools"
 * @property {number} sessionCount  - 该项目下的会话数量
 */

/**
 * @typedef {Object} Session
 * @property {string}  id           - UUID（会话文件名，不含 .jsonl）
 * @property {string}  projectSlug  - 所属项目 slug
 * @property {string}  [slug]       - 可读会话名，如 "stateful-stirring-lemur"
 * @property {string}  [cwd]        - 工作目录
 * @property {string}  [gitBranch]  - Git 分支
 * @property {string}  [version]    - Claude 版本号
 * @property {string}  [startedAt]  - 第一条消息的时间（ISO 8601）
 * @property {string}  [updatedAt]  - 最后一条消息的时间（ISO 8601）
 * @property {number}  messageCount - user+assistant 消息总数
 * @property {string}  [title]      - 第一条 user text 内容（截断到 80 字）
 * @property {boolean} hasSubagents - 是否包含 subagents
 */

/**
 * @typedef {Object} Message
 * @property {string}   uuid
 * @property {string}   parentUuid
 * @property {'user'|'assistant'} role
 * @property {string}   timestamp
 * @property {object[]} content     - ContentBlock 数组
 * @property {string}   [model]     - assistant only
 * @property {object}   [usage]     - assistant only，含 token 用量
 */

const { getClaudeDir, decodeSlug, listProject } = require('./projects');
const { listSession, listAllSession } = require('./sessions');
const { readSession, search } = require('./messages');

module.exports = {
  // 项目相关
  listProject,
  decodeSlug,
  getClaudeDir,

  // 会话相关
  listSession,
  listAllSession,

  // 消息相关
  readSession,
  search,
};
