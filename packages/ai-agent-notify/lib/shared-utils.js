const fs = require("fs");

function getArgValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : "";
}

function getEnvFirst(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function parsePositiveInteger(rawValue, fallbackValue = null) {
  const parsed = parseInt(rawValue, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function stripUtf8Bom(value) {
  return typeof value === "string" ? value.replace(/^\uFEFF/, "") : value;
}

function fileExistsCaseInsensitive(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

module.exports = {
  fileExistsCaseInsensitive,
  getArgValue,
  getEnvFirst,
  parsePositiveInteger,
  stripUtf8Bom,
};
