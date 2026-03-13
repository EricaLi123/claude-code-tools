#!/usr/bin/env node
'use strict';

const x = require('..');
const pkg = require('../package.json');

// ANSI 颜色工具
const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  yellow:  '\x1b[33m',
  green:   '\x1b[32m',
  magenta: '\x1b[35m',
  gray:    '\x1b[90m',
  red:     '\x1b[31m',
};

const bin = Object.keys(pkg.bin)[0];

function relativeTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (diff < 3600_000) return m > 0 ? `${m}m ago` : `${s}s ago`;
  if (diff < 86400_000) return `${h}h ${m % 60}m ago`;
  if (diff < 7 * 86400_000) return `${d}d ago`;
  return new Date(iso).toLocaleString('zh-CN');
}

function kv(key, value) {
  console.log(`  ${c.gray}${key.padEnd(12)}${c.reset} ${value}`);
}

// ── help ──────────────────────────────────────────────────────────────────────

const HELP = {
  root: `
${c.bold}Usage:${c.reset} ${bin} <command> [options]

${c.bold}Commands:${c.reset}
  project                    list all projects
  session [project-slug]     list sessions, all or filtered by project
  read <project-slug> <id>   print messages in a session
  search <query>             full-text search across all sessions

${c.bold}Options:${c.reset}
  -V, --version              output the version number
  -h, --help                 display help for command

Run ${c.bold}${bin} <command> --help${c.reset} for command-specific options.
`,

  project: `
${c.bold}Usage:${c.reset} ${bin} project [options]

List all local Claude Code projects.

${c.bold}Options:${c.reset}
  --json          output raw JSON
  -h, --help      display help for command
`,

  session: `
${c.bold}Usage:${c.reset} ${bin} session [project-slug] [options]

List sessions. If project-slug is omitted, lists all sessions across all projects.

${c.bold}Options:${c.reset}
  --limit <n>     limit number of results
  --json          output raw JSON
  -h, --help      display help for command
`,

  read: `
${c.bold}Usage:${c.reset} ${bin} read <project-slug> <session-id> [options]

Print messages in a session.

${c.bold}Options:${c.reset}
  --json          output raw JSON
  -h, --help      display help for command
`,

  search: `
${c.bold}Usage:${c.reset} ${bin} search <query> [options]

Full-text search across all sessions (matches text content of messages).

${c.bold}Options:${c.reset}
  --limit <n>       limit number of matched sessions  (default: 10)
  --project <slug>  search within a specific project
  --json            output raw JSON
  -h, --help        display help for command
`,
};

// ── 命令：project ─────────────────────────────────────────────────────────────
function cmdProject(args) {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP.project);
    return;
  }
  const projects = x.listProject();
  if (args.includes('--json')) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }
  console.log(`\n${c.bold}${c.green}${projects.length}${c.reset} projects\n`);
  for (const p of projects) {
    const count = `[${p.sessionCount}]`.padEnd(5);
    console.log(`  ${c.gray}${count}${c.reset} ${p.path}`);
  }
  console.log();
}

// ── 命令：session [slug] ──────────────────────────────────────────────────────
function cmdSession(args) {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP.session);
    return;
  }
  const isJson = args.includes('--json');
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag !== -1 ? parseInt(args[limitFlag + 1], 10) : null;

  // 排除 flag 本身和 flag 的值，剩余第一个位置参数为 slug
  const flagValues = new Set(limitFlag !== -1 ? [args[limitFlag + 1]] : []);
  const slug = args.find(a => !a.startsWith('-') && !flagValues.has(a));

  const sessions = slug ? x.listSession(slug) : x.listAllSession();

  if (isJson) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  const shown = sessions.slice(0, limit !== null ? limit : sessions.length);

  console.log(`\n${c.bold}${c.green}${sessions.length}${c.reset} sessions${slug ? ` in ${slug}` : ''}\n`);
  for (const s of shown) {
    const name = s.slug || s.id;
    console.log(`  ${c.bold}${c.magenta}${name}${c.reset}  ${c.gray}${relativeTime(s.updatedAt)}${c.reset}`);
    if (s.cwd) kv('cwd', s.cwd);
    kv('id', c.dim + s.id + c.reset);
    if (s.title) kv('title', c.yellow + s.title.substring(0, 80) + c.reset);
    console.log();
  }
  if (sessions.length > shown.length) {
    console.log(`  ${c.gray}... and ${sessions.length - shown.length} more (use --limit N to show more)${c.reset}\n`);
  }
}

// ── 命令：read <project-slug> <session-id> ────────────────────────────────────
function cmdRead(args) {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP.read);
    return;
  }
  const isJson = args.includes('--json');
  const positional = args.filter(a => !a.startsWith('-'));
  const [projectSlug, sessionId] = positional;

  if (!projectSlug || !sessionId) {
    process.stderr.write(`${c.red}error: missing required argument(s)${c.reset}\n`);
    process.stderr.write(HELP.read);
    process.exit(1);
  }

  const messages = x.readSession(projectSlug, sessionId);

  if (isJson) {
    console.log(JSON.stringify(messages, null, 2));
    return;
  }

  console.log(`\n${c.bold}${c.green}${messages.length}${c.reset} messages\n`);
  for (const msg of messages) {
    const roleColor = msg.role === 'user' ? c.cyan : c.green;
    const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('zh-CN') : '';
    console.log(`  ${c.bold}${roleColor}${msg.role.toUpperCase()}${c.reset}  ${c.gray}${time}${c.reset}`);
    for (const block of msg.content) {
      if (block.type === 'text') {
        const preview = String(block.text || '').replace(/\s+/g, ' ').substring(0, 200);
        console.log(`    ${c.yellow}${preview}${c.reset}`);
      } else {
        console.log(`    ${c.gray}[${block.type}]${c.reset}`);
      }
    }
    console.log();
  }
}

// ── 命令：search <query> ──────────────────────────────────────────────────────
function cmdSearch(args) {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP.search);
    return;
  }
  const isJson = args.includes('--json');
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag !== -1 ? parseInt(args[limitFlag + 1], 10) : 10;
  const projectFlag = args.indexOf('--project');
  const project = projectFlag !== -1 ? args[projectFlag + 1] : undefined;

  const flagValues = new Set([
    limitFlag !== -1 ? args[limitFlag + 1] : null,
    projectFlag !== -1 ? args[projectFlag + 1] : null,
  ].filter(Boolean));
  const query = args.find(a => !a.startsWith('-') && !flagValues.has(a));

  if (!query) {
    process.stderr.write(`${c.red}error: missing required argument 'query'${c.reset}\n`);
    process.stderr.write(HELP.search);
    process.exit(1);
  }

  const results = x.search(query, { limit, project });

  if (isJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(`\n${c.bold}${c.green}${results.length}${c.reset} sessions matched "${query}"\n`);
  for (const r of results) {
    const name = r.session.slug || r.session.id;
    console.log(`  ${c.bold}${c.magenta}${name}${c.reset}  ${c.gray}(${r.matches.length} matches)${c.reset}`);
    if (r.matches[0]) {
      const preview = String(r.matches[0].text).replace(/\s+/g, ' ').substring(0, 120);
      console.log(`    ${c.yellow}${preview}${c.reset}`);
    }
    console.log();
  }
}

// ── 路由 ──────────────────────────────────────────────────────────────────────
const [,, cmd, ...args] = process.argv;

if (cmd === '-V' || cmd === '--version') {
  console.log(pkg.version);
  process.exit(0);
}

if (!cmd || cmd === '-h' || cmd === '--help') {
  process.stdout.write(HELP.root);
  process.exit(0);
}

switch (cmd) {
  case 'project':  cmdProject(args); break;
  case 'session':  cmdSession(args); break;
  case 'read':     cmdRead(args);    break;
  case 'search':   cmdSearch(args);  break;
  default:
    process.stderr.write(`${c.red}error: unknown command '${cmd}'${c.reset}\n`);
    process.stderr.write(HELP.root);
    process.exit(1);
}
