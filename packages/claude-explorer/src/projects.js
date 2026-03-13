'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 返回 ~/.claude 目录路径，优先使用 HOME，其次 USERPROFILE。
 * @returns {string}
 */
function getClaudeDir() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.claude');
}

/**
 * 将 project slug 解码为文件系统路径（best-effort）。
 *
 * Claude Code slug 编码规则：
 *   - `:` → `-`（Windows 盘符后的冒号）
 *   - 路径分隔符 `\` / `/` → `-`
 *
 * 因此 `D:\XAGIT\claude-code-tools` 编码为 `D--XAGIT-claude-code-tools`：
 *   - `D` + `:` (→`-`) + `\` (→`-`) = `D--`
 *   - `XAGIT` + `\` (→`-`) = `XAGIT-`
 *   - `claude-code-tools`（字面连字符不变）
 *
 * 解码策略：
 *   1. 若以 `X--` 开头（X 为单字母），还原为 `X:\`
 *   2. 其余 `-` 全部视为路径分隔符
 *
 * ⚠️ 目录名本身含连字符时会被错误拆分（不可避免的歧义）。
 *
 * @param {string} slug
 * @returns {string}
 */
function decodeSlug(slug) {
  // 处理 Windows 盘符前缀：如 "D--" → "D:\"
  const winDrivePrefix = /^([A-Za-z])--(.*)$/;
  const match = slug.match(winDrivePrefix);
  if (match) {
    const drive = match[1].toUpperCase() + ':';
    const rest = match[2];
    // rest 中的 "-" 全部视为路径分隔符
    return drive + path.sep + rest.split('-').join(path.sep);
  }

  // 非 Windows 盘符前缀："-" 全部视为路径分隔符
  return slug.split('-').join(path.sep);
}

/**
 * 列举 ~/.claude/projects/ 下所有项目。
 * @returns {import('./index').Project[]}
 */
function listProject() {
  const projectsDir = path.join(getClaudeDir(), 'projects');
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const projectDir = path.join(projectsDir, slug);

    // 统计 .jsonl 文件数量作为 sessionCount
    let sessionCount = 0;
    try {
      const files = fs.readdirSync(projectDir);
      sessionCount = files.filter(f => f.endsWith('.jsonl')).length;
    } catch (_) {}

    projects.push({
      slug,
      path: decodeSlug(slug),
      sessionCount,
    });
  }

  return projects;
}

module.exports = { getClaudeDir, decodeSlug, listProject };
