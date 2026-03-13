'use strict';

const fs = require('fs');
const path = require('path');
const { getClaudeDir } = require('./projects');
const { readJsonl, listJsonlFiles } = require('./reader');

/**
 * 从 .jsonl 行记录中提取会话元数据。
 * @param {string} projectSlug
 * @param {string} sessionId   - UUID（不含 .jsonl 后缀）
 * @param {string} filePath    - .jsonl 文件路径
 * @returns {import('./index').Session}
 */
function extractSessionMeta(projectSlug, sessionId, filePath) {
  const records = readJsonl(filePath);

  // 只保留 user/assistant 类型的记录
  const msgs = records.filter(r => r.type === 'user' || r.type === 'assistant');

  let slug;
  let cwd;
  let gitBranch;
  let version;
  let startedAt;
  let updatedAt;
  let title;
  let messageCount = 0;

  // 找根消息（parentUuid === null）用于提取 slug 和 title
  const rootMsg = msgs.find(r => r.parentUuid === null && r.type === 'user');

  if (rootMsg) {
    slug = rootMsg.slug;
    const content = rootMsg.message && rootMsg.message.content;
    if (Array.isArray(content)) {
      const textBlock = content.find(c => c.type === 'text' && c.text);
      if (textBlock) {
        title = textBlock.text.trim().replace(/\s+/g, ' ').substring(0, 80);
      }
    } else if (typeof content === 'string') {
      title = content.trim().replace(/\s+/g, ' ').substring(0, 80);
    }
  }

  for (const r of msgs) {
    // 从任意记录中获取基础信息（所有记录均含这些字段）
    if (!cwd && r.cwd) cwd = r.cwd;
    if (!gitBranch && r.gitBranch) gitBranch = r.gitBranch;
    if (!version && r.version) version = r.version;

    // slug 也可能在非根消息中出现（兜底）
    if (!slug && r.slug) slug = r.slug;

    const ts = r.timestamp;
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!updatedAt || ts > updatedAt) updatedAt = ts;
    }

    messageCount++;
  }

  // 检测是否含 subagents：同名目录（无扩展名）存在，且有 subagents/ 子目录
  const sessionDir = filePath.replace(/\.jsonl$/, '');
  let hasSubagents = false;
  try {
    const subagentsDir = path.join(sessionDir, 'subagents');
    hasSubagents = fs.existsSync(subagentsDir) && fs.statSync(subagentsDir).isDirectory();
  } catch (_) {}

  return {
    id: sessionId,
    projectSlug,
    slug,
    cwd,
    gitBranch,
    version,
    startedAt,
    updatedAt,
    messageCount,
    title,
    hasSubagents,
  };
}

/**
 * 列举某项目的所有会话，按 updatedAt 倒序排列。
 * @param {string} projectSlug
 * @returns {import('./index').Session[]}
 */
function listSession(projectSlug) {
  const projectDir = path.join(getClaudeDir(), 'projects', projectSlug);
  const files = listJsonlFiles(projectDir);

  const sessions = [];
  for (const filePath of files) {
    const sessionId = path.basename(filePath, '.jsonl');
    try {
      const meta = extractSessionMeta(projectSlug, sessionId, filePath);
      sessions.push(meta);
    } catch (_) {
      // 跳过无法解析的会话文件
    }
  }

  // 按 updatedAt 倒序
  sessions.sort((a, b) => {
    const ta = a.updatedAt || '';
    const tb = b.updatedAt || '';
    if (tb > ta) return 1;
    if (tb < ta) return -1;
    return 0;
  });

  return sessions;
}

/**
 * 列举所有项目的所有会话，按 updatedAt 倒序排列。
 * @returns {import('./index').Session[]}
 */
function listAllSession() {
  const { listProject } = require('./projects');
  const projects = listProject();

  const all = [];
  for (const project of projects) {
    const sessions = listSession(project.slug);
    all.push(...sessions);
  }

  all.sort((a, b) => {
    const ta = a.updatedAt || '';
    const tb = b.updatedAt || '';
    if (tb > ta) return 1;
    if (tb < ta) return -1;
    return 0;
  });

  return all;
}

module.exports = { listSession, listAllSession };
