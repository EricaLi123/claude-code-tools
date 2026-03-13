'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 逐行读取 .jsonl 文件，解析每行为 JSON 对象。
 * 单行解析失败时跳过，不抛异常。
 * @param {string} filePath
 * @returns {object[]}
 */
function readJsonl(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return [];
  }

  const results = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed));
    } catch (_) {
      // 跳过无法解析的行
    }
  }
  return results;
}

/**
 * 列举目录下所有 .jsonl 文件的路径。
 * @param {string} dir
 * @returns {string[]}
 */
function listJsonlFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(name => name.endsWith('.jsonl'))
      .map(name => path.join(dir, name));
  } catch (_) {
    return [];
  }
}

module.exports = { readJsonl, listJsonlFiles };
