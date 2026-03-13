'use strict';

const path = require('path');
const { getClaudeDir } = require('./projects');
const { readJsonl } = require('./reader');

/**
 * 噪音类型：跳过这些记录，不作为对话消息返回。
 */
const NOISE_TYPES = new Set(['file-history-snapshot', 'progress', 'system']);

/**
 * 读取某会话的完整消息列表，过滤掉 progress/system 等噪音。
 * @param {string} projectSlug
 * @param {string} sessionId
 * @returns {import('./index').Message[]}
 */
function readSession(projectSlug, sessionId) {
  const filePath = path.join(
    getClaudeDir(), 'projects', projectSlug, sessionId + '.jsonl'
  );
  const records = readJsonl(filePath);

  const messages = [];
  for (const r of records) {
    // 跳过噪音类型
    if (NOISE_TYPES.has(r.type)) continue;
    // 只保留 user/assistant
    if (r.type !== 'user' && r.type !== 'assistant') continue;

    const msg = r.message || {};
    messages.push({
      uuid: r.uuid,
      parentUuid: r.parentUuid,
      role: msg.role || r.type,
      timestamp: r.timestamp,
      content: parseContent(msg.content),
      model: msg.model,
      usage: msg.usage,
    });
  }

  return messages;
}

/**
 * 将 content 字段统一为 ContentBlock 数组。
 * content 可能是字符串（旧格式）或 ContentBlock[]。
 * @param {string|Array|undefined} content
 * @returns {object[]}
 */
function parseContent(content) {
  if (!content) return [];
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content;
  }
  return [];
}

/**
 * 搜索会话内容，关键词匹配 text 类型的 content block。
 * @param {string} query                      - 搜索关键词（大小写不敏感）
 * @param {object} [options]
 * @param {string} [options.project]          - 限定项目 slug
 * @param {number} [options.limit]            - 最多返回多少条匹配会话
 * @returns {Array<{session: import('./index').Session, matches: object[]}>}
 */
function search(query, options = {}) {
  const { listSession, listAllSession } = require('./sessions');
  const { limit = 20, project: projectSlug } = options;

  const lowerQuery = query.toLowerCase();

  // 确定要搜索的会话列表
  let sessions;
  if (projectSlug) {
    sessions = listSession(projectSlug);
  } else {
    sessions = listAllSession();
  }

  const results = [];
  for (const session of sessions) {
    if (results.length >= limit) break;

    const messages = readSession(session.projectSlug, session.id);
    const matches = [];

    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type !== 'text') continue;
        const text = block.text || '';
        if (text.toLowerCase().includes(lowerQuery)) {
          matches.push({
            role: msg.role,
            text,
            timestamp: msg.timestamp,
          });
        }
      }
    }

    if (matches.length > 0) {
      results.push({ session, matches });
    }
  }

  return results;
}

module.exports = { readSession, search };
