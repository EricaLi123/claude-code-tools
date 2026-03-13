'use strict';

const s = require('..');

// ANSI 颜色工具
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
  gray:   '\x1b[90m',
};

function relativeTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (diff < 3600_000) {
    return m > 0 ? `${m}m ago` : `${s}s ago`;
  }
  if (diff < 86400_000) {
    return `${h}h ${m % 60}m ago`;
  }
  return new Date(iso).toLocaleString('zh-CN');
}

function header(title) {
  console.log(`\n${c.bold}${c.cyan}── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}${c.reset}`);
}

function kv(key, value, indent = '  ') {
  console.log(`${indent}${c.gray}${key.padEnd(14)}${c.reset} ${value}`);
}

function badge(text, color = c.blue) {
  return `${color}${c.bold}${text}${c.reset}`;
}

// ── listProject ──────────────────────────────────────────────────────────────
header('listProject()');
const projects = s.listProject();
console.log(`  ${badge(projects.length, c.green)} projects found\n`);
projects.slice(0, 5).forEach(p => {
  const n = `[${p.sessionCount}]`.padEnd(5);
  console.log(`  ${c.gray}${n}${c.reset} ${p.path}`);
});
if (projects.length > 5) {
  console.log(`  ${c.gray}... and ${projects.length - 5} more${c.reset}`);
}

// ── listAllSession ────────────────────────────────────────────────────────────
header('listAllSession()  [top 10]');
const allSessions = s.listAllSession();
console.log(`  ${badge(allSessions.length, c.green)} sessions total\n`);
allSessions.slice(0, 10).forEach((sess, i) => {
  console.log(`  ${c.bold}#${i + 1}  ${c.magenta}${sess.slug || sess.id}${c.reset}`);
  kv('id',        c.dim + sess.id + c.reset, '    ');
  kv('cwd',       sess.cwd || s.decodeSlug(sess.projectSlug), '    ');
  kv('title',     c.yellow + (sess.title || '(no title)') + c.reset, '    ');
  kv('updatedAt', relativeTime(sess.updatedAt), '    ');
  console.log();
});

// ── readSession ───────────────────────────────────────────────────────────────
if (allSessions.length > 0) {
  const latest = allSessions[0];
  header('readSession()  [latest session, first 2 msgs]');
  console.log(`  ${c.gray}${latest.cwd || s.decodeSlug(latest.projectSlug)} / ${latest.id}${c.reset}\n`);

  const messages = s.readSession(latest.projectSlug, latest.id);
  console.log(`  ${badge(messages.length, c.green)} messages total\n`);

  messages.slice(0, 2).forEach((msg, i) => {
    const roleColor = msg.role === 'user' ? c.blue : c.green;
    console.log(`  ${c.bold}[${i}] ${roleColor}${msg.role.toUpperCase()}${c.reset}  ${c.gray}${msg.timestamp}${c.reset}`);
    const textBlock = msg.content.find(blk => blk.type === 'text');
    if (textBlock) {
      const preview = String(textBlock.text || '').replace(/\s+/g, ' ').substring(0, 120);
      console.log(`      ${c.yellow}${preview}${c.reset}`);
    }
    console.log();
  });
}

// ── search ────────────────────────────────────────────────────────────────────
header('search("Claude Code", { limit: 3 })');
const results = s.search('Claude Code', { limit: 3 });
console.log(`  ${badge(results.length, c.green)} sessions matched\n`);
results.forEach((r, i) => {
  console.log(`  ${c.bold}#${i + 1}  ${c.magenta}${r.session.slug || r.session.id}${c.reset}  ${c.gray}(${r.matches.length} matches)${c.reset}`);
  if (r.matches.length > 0) {
    const preview = String(r.matches[0].text).replace(/\s+/g, ' ').substring(0, 100);
    console.log(`      ${c.yellow}${preview}${c.reset}`);
  }
  console.log();
});

// ── 工具函数 ────────────────────────────────────────────────────────────────────
header('utils');
console.log(`  decodeSlug('D--XAGIT-claude-code-tools')  ${c.yellow}${s.decodeSlug('D--XAGIT-claude-code-tools')}${c.reset}`);
console.log(`  decodeSlug('C--Users-alice-projects')      ${c.yellow}${s.decodeSlug('C--Users-alice-projects')}${c.reset}`);
console.log(`  getClaudeDir()                             ${c.yellow}${s.getClaudeDir()}${c.reset}`);

console.log(`\n${c.green}${c.bold}✓ Smoke test passed.${c.reset}\n`);
