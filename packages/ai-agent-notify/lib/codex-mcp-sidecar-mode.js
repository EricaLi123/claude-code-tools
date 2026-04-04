const os = require("os");
const path = require("path");
const readline = require("readline");

const { handleMcpServerMessage } = require("./codex-mcp-server");
const { ensureCodexSessionWatchRunning } = require("./codex-session-watch-runner");
const { resolveSidecarSessionCandidate, startSidecarSessionResolver } = require("./codex-sidecar-resolver");
const { writeSidecarRecord } = require("./codex-sidecar-store");
const { createRuntime, findParentInfo } = require("./notify-runtime");
const { stripUtf8Bom } = require("./shared-utils");

async function runCodexMcpSidecarMode({ argv, cliPath, packageVersion }) {
  if (argv[0] === "--help" || argv[0] === "help") {
    return { handledHelp: true };
  }

  const runtime = createRuntime(`codex-mcp-sidecar-${Date.now()}`);
  ensureCodexSessionWatchRunning({ cliPath, log: runtime.log });
  const parentInfo = findParentInfo(runtime.log);
  const sessionsDir = path.join(getCodexHomeDir(), "sessions");
  const recordId = `codex-mcp-sidecar-${process.pid}-${Date.now()}`;
  let sidecarRecord = writeSidecarRecord({
    recordId,
    pid: process.pid,
    parentPid: process.ppid,
    cwd: process.cwd(),
    sessionId: "",
    startedAt: new Date().toISOString(),
    resolvedAt: "",
    hwnd: parentInfo.hwnd,
    shellPid: parentInfo.shellPid,
    isWindowsTerminal: parentInfo.isWindowsTerminal,
  });

  runtime.log(
    `started mode=codex-mcp-sidecar cwd=${sidecarRecord.cwd} shellPid=${sidecarRecord.shellPid || ""} hwnd=${sidecarRecord.hwnd || ""} sessionsDir=${sessionsDir} packageRoot=${runtime.buildInfo.packageRoot}`
  );

  const resolver = startSidecarSessionResolver({
    getCurrentRecord: () => sidecarRecord,
    updateRecord(nextRecord) {
      sidecarRecord = writeSidecarRecord(nextRecord);
      return sidecarRecord;
    },
    sessionsDir,
    log: runtime.log,
    findCandidate: resolveSidecarSessionCandidate,
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    resolver.stop();
    runtime.log(
      `stopped mode=codex-mcp-sidecar recordId=${recordId} sessionId=${sidecarRecord.sessionId || ""} retained=1`
    );
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  try {
    await Promise.all([
      serveMinimalMcpServer({ packageVersion, runtime }),
      resolver.done,
    ]);
  } finally {
    cleanup();
  }

  return { handledHelp: false };
}

function serveMinimalMcpServer({ packageVersion, runtime }) {
  const reader = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  return new Promise((resolve) => {
    reader.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      let message;
      try {
        message = JSON.parse(stripUtf8Bom(line));
      } catch (error) {
        runtime.log(`mcp parse failed error=${error.message}`);
        return;
      }

      handleMcpServerMessage(message, runtime.log, packageVersion);
    });

    reader.on("close", resolve);
    process.stdin.on("end", resolve);
  });
}

function getCodexHomeDir() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

module.exports = {
  runCodexMcpSidecarMode,
};
