const sidecarMatcher = require("./codex-sidecar-matcher");
const sidecarStore = require("./codex-sidecar-store");

module.exports = {
  deleteSidecarRecord: sidecarStore.deleteSidecarRecord,
  findSidecarTerminalContextForProjectDir: sidecarMatcher.findSidecarTerminalContextForProjectDir,
  findSidecarTerminalContextForSession: sidecarMatcher.findSidecarTerminalContextForSession,
  getSidecarStateDir: sidecarStore.getSidecarStateDir,
  pruneStaleSidecarRecords: sidecarStore.pruneStaleSidecarRecords,
  writeSidecarRecord: sidecarStore.writeSidecarRecord,
};
