const fs = require("fs");
const path = require("path");

const COMMAND_APPROVAL_ROOT_MAX_DEPTH = 8;
const COMMAND_APPROVAL_ROOT_MARKERS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "Gemfile",
  "composer.json",
  ".git",
];

function matchesApprovedCommandRule(args, approvedCommandRules) {
  if (!args || !Array.isArray(approvedCommandRules) || !approvedCommandRules.length) {
    return false;
  }

  const normalizedCommand = normalizeShellCommandForMatch(args.command);
  const normalizedPrefixRule = normalizePrefixRule(args.prefix_rule);

  return approvedCommandRules.some((rule) => {
    if (!rule || !rule.shellCommand) {
      return false;
    }

    const normalizedRuleCommand = normalizeShellCommandForMatch(rule.shellCommand);
    if (normalizedCommand && normalizedRuleCommand && normalizedCommand === normalizedRuleCommand) {
      return true;
    }

    if (
      normalizedPrefixRule.length &&
      arrayStartsWith(rule.shellCommandTokens || [], normalizedPrefixRule)
    ) {
      return true;
    }

    return false;
  });
}

function normalizeShellCommandForMatch(command) {
  return String(command || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizePrefixRule(prefixRule) {
  if (!Array.isArray(prefixRule)) {
    return [];
  }

  return prefixRule
    .filter((value) => typeof value === "string")
    .map((value) => stripMatchingQuotes(String(value).trim()).toLowerCase())
    .filter(Boolean);
}

function isLikelyReadOnlyShellCommand(args) {
  if (!args || typeof args.command !== "string") {
    return false;
  }

  const tokens = extractLeadingCommandTokens(args.command);
  if (!tokens.length) {
    return false;
  }

  const command = tokens[0];
  if (
    new Set([
      "cat",
      "dir",
      "findstr",
      "get-childitem",
      "get-content",
      "ls",
      "rg",
      "select-string",
      "type",
    ]).has(command)
  ) {
    return true;
  }

  if (command === "git") {
    return new Set(["branch", "diff", "log", "remote", "rev-parse", "show", "status"]).has(
      tokens[1] || ""
    );
  }

  if (command === "node") {
    return tokens[1] === "-c";
  }

  return false;
}

function extractCommandApprovalRoots(args) {
  if (!args || typeof args.command !== "string") {
    return [];
  }

  const workdir = normalizeShellCommandPath(args.workdir);
  const roots = new Set();
  const absolutePathPattern = /[A-Za-z]:[\\/][^"'`\r\n|;]+/g;

  const pushRoot = (value) => {
    const normalized = normalizeShellCommandPath(value);
    if (!normalized) {
      return;
    }

    let root = normalized;
    const fsPath = normalized.replace(/\//g, path.sep);
    if (path.extname(fsPath)) {
      root = normalizeShellCommandPath(findCommandApprovalRootPath(path.dirname(fsPath)));
    } else {
      root = normalizeShellCommandPath(findCommandApprovalRootPath(fsPath));
    }

    if (root) {
      roots.add(root);
    }
  };

  let match;
  while ((match = absolutePathPattern.exec(args.command)) !== null) {
    pushRoot(match[0]);
  }

  tokenizeShellCommand(args.command).forEach((token) => {
    const candidate = normalizePathCandidate(token);
    if (!candidate) {
      return;
    }

    if (isWindowsAbsolutePath(candidate)) {
      pushRoot(candidate);
      return;
    }

    if (!workdir || !looksLikeRelativePathCandidate(candidate)) {
      return;
    }

    pushRoot(path.resolve(workdir.replace(/\//g, path.sep), candidate));
  });

  return Array.from(roots);
}

function extractLeadingCommandTokens(command) {
  const tokens = tokenizeShellCommand(command);
  const operators = new Set(["|", ";", "&&", "||"]);
  const result = [];
  let seenCommand = false;

  for (const token of tokens) {
    if (!token) {
      continue;
    }

    if (!seenCommand) {
      if (operators.has(token)) {
        continue;
      }
      if (looksLikePowerShellAssignment(token)) {
        continue;
      }

      seenCommand = true;
      result.push(normalizeShellToken(token));
      continue;
    }

    if (operators.has(token)) {
      break;
    }

    result.push(normalizeShellToken(token));
  }

  return result;
}

function tokenizeShellCommand(command) {
  const text = String(command || "");
  const tokens = [];
  let current = "";
  let quote = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1] || "";

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push(char + next);
      current = "";
      index += 1;
      continue;
    }

    if (char === "|" || char === ";") {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push(char);
      current = "";
      continue;
    }

    if (/\s/.test(char)) {
      if (current.trim()) {
        tokens.push(current.trim());
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    tokens.push(current.trim());
  }

  return tokens;
}

function looksLikePowerShellAssignment(token) {
  return /^\$[A-Za-z_][A-Za-z0-9_:.]*=/.test(String(token || ""));
}

function normalizePathCandidate(value) {
  return stripMatchingQuotes(String(value || "").trim())
    .replace(/^[([{]+/, "")
    .replace(/[)\],;]+$/, "");
}

function isWindowsAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || ""));
}

function looksLikeRelativePathCandidate(value) {
  const text = String(value || "");
  if (
    !text ||
    /[\r\n]/.test(text) ||
    /^[A-Za-z]:[\\/]/.test(text) ||
    /^[A-Za-z]+:\/\//.test(text) ||
    text.startsWith("$")
  ) {
    return false;
  }

  return text.startsWith(".") || /[\\/]/.test(text);
}

function normalizeShellCommandPath(value) {
  const candidate = normalizePathCandidate(value);
  if (!isWindowsAbsolutePath(candidate)) {
    return "";
  }

  let normalized = candidate.replace(/\\/g, "/");
  if (normalized.length > 3) {
    normalized = normalized.replace(/\/+$/, "");
  }
  return normalized.toLowerCase();
}

function isPathWithinRoot(candidatePath, rootPath) {
  const candidate = normalizeShellCommandPath(candidatePath);
  const root = normalizeShellCommandPath(rootPath);
  if (!candidate || !root) {
    return false;
  }

  return candidate === root || candidate.startsWith(`${root}/`);
}

function findCommandApprovalRootPath(value) {
  let currentPath = "";
  try {
    currentPath = path.resolve(String(value || ""));
  } catch {
    return String(value || "");
  }

  let bestGitRoot = "";
  let currentDir = currentPath;

  for (let depth = 0; depth <= COMMAND_APPROVAL_ROOT_MAX_DEPTH; depth += 1) {
    const marker = findCommandApprovalRootMarker(currentDir);
    if (marker && marker !== ".git") {
      return currentDir;
    }
    if (marker === ".git" && !bestGitRoot) {
      bestGitRoot = currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (!parentDir || parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return bestGitRoot || currentPath;
}

function findCommandApprovalRootMarker(dirPath) {
  if (!dirPath) {
    return "";
  }

  return (
    COMMAND_APPROVAL_ROOT_MARKERS.find((marker) => fs.existsSync(path.join(dirPath, marker))) || ""
  );
}

function normalizeShellToken(token) {
  return stripMatchingQuotes(String(token || "").trim()).toLowerCase();
}

function stripMatchingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function arrayStartsWith(values, prefix) {
  if (!Array.isArray(values) || !Array.isArray(prefix) || prefix.length === 0) {
    return false;
  }

  if (values.length < prefix.length) {
    return false;
  }

  for (let index = 0; index < prefix.length; index += 1) {
    if (values[index] !== prefix[index]) {
      return false;
    }
  }

  return true;
}

module.exports = {
  arrayStartsWith,
  extractCommandApprovalRoots,
  extractLeadingCommandTokens,
  findCommandApprovalRootPath,
  isLikelyReadOnlyShellCommand,
  isPathWithinRoot,
  matchesApprovedCommandRule,
  normalizeShellCommandPath,
  tokenizeShellCommand,
};
