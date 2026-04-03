const path = require("path");

function normalizeWindowsPath(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  try {
    return path.resolve(trimmed).replace(/\//g, "\\").toLowerCase();
  } catch {
    return trimmed.replace(/\//g, "\\").toLowerCase();
  }
}

function isSameWindowsPath(left, right) {
  if (!left || !right) {
    return false;
  }

  return normalizeWindowsPath(left) === normalizeWindowsPath(right);
}

function splitWindowsPath(value) {
  return String(value || "")
    .split("\\")
    .filter(Boolean);
}

function countCommonSegments(left, right) {
  const max = Math.min(left.length, right.length);
  let count = 0;

  while (count < max && left[count] === right[count]) {
    count += 1;
  }

  return count;
}

module.exports = {
  countCommonSegments,
  isSameWindowsPath,
  normalizeWindowsPath,
  splitWindowsPath,
};
