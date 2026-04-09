const crypto = require("crypto");

module.exports = function runCompletionFallbackTests(h) {
  const {
    assert,
    fs,
    normalizeIncomingNotification,
    notifyRuntime,
    path,
    ROOT,
    section,
    test,
  } = h;
  const completionReceipts = require(path.join(
    ROOT,
    "lib",
    "codex-completion-receipts.js"
  ));
  const receiptsDir = path.join(notifyRuntime.LOG_DIR, "completion-receipts");

  function getReceiptPathForKey(key) {
    const fileName = `${crypto.createHash("sha1").update(key).digest("hex")}.json`;
    return path.join(receiptsDir, fileName);
  }

  function deleteReceiptByKey(key) {
    if (!key) {
      return;
    }

    const receiptPath = getReceiptPathForKey(key);
    if (!fs.existsSync(receiptPath)) {
      return;
    }

    try {
      fs.unlinkSync(receiptPath);
    } catch {}
  }

  section("Completion fallback");

  test("writeCodexCompletionReceiptForNotification writes a Stop receipt keyed by session + turn", () => {
    const sessionId = `completion-session-${process.pid}-${Date.now()}`;
    const turnId = `turn-${process.hrtime.bigint().toString()}`;
    const key = completionReceipts.buildCodexCompletionReceiptKey({
      sessionId,
      turnId,
      eventName: "Stop",
    });
    const receiptPath = getReceiptPathForKey(key);

    deleteReceiptByKey(key);

    try {
      completionReceipts.writeCodexCompletionReceiptForNotification({
        sourceId: "codex-legacy-notify",
        eventName: "Stop",
        sessionId,
        turnId,
      });

      assert(fs.existsSync(receiptPath), "expected Stop completion receipt file to exist");
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));

      assert(receipt.key === key, "receipt key mismatch");
      assert(receipt.sessionId === sessionId, "receipt sessionId mismatch");
      assert(receipt.turnId === turnId, "receipt turnId mismatch");
      assert(receipt.eventName === "Stop", "receipt eventName mismatch");
      assert(
        typeof receipt.expiresAtMs === "number" && receipt.expiresAtMs > Date.now(),
        "receipt expiresAtMs should be in the future"
      );
      assert(
        completionReceipts.hasCodexCompletionReceipt({
          sessionId,
          turnId,
          eventName: "Stop",
        }),
        "expected Stop receipt lookup to succeed"
      );
    } finally {
      deleteReceiptByKey(key);
    }
  });

  test("writeCodexCompletionReceiptForNotification ignores non-Stop payloads and missing turn ids", () => {
    const nonStopSessionId = `completion-nonstop-${process.pid}-${Date.now()}`;
    const nonStopTurnId = `turn-${process.hrtime.bigint().toString()}`;
    const nonStopKey = completionReceipts.buildCodexCompletionReceiptKey({
      sessionId: nonStopSessionId,
      turnId: nonStopTurnId,
      eventName: "Stop",
    });
    const nonStopReceiptPath = getReceiptPathForKey(nonStopKey);

    deleteReceiptByKey(nonStopKey);

    try {
      const nonStopResult = completionReceipts.writeCodexCompletionReceiptForNotification({
        sourceId: "codex-legacy-notify",
        eventName: "PermissionRequest",
        sessionId: nonStopSessionId,
        turnId: nonStopTurnId,
      });
      const missingTurnResult =
        completionReceipts.writeCodexCompletionReceiptForNotification({
          sourceId: "codex-legacy-notify",
          eventName: "Stop",
          sessionId: `completion-missing-turn-${process.pid}-${Date.now()}`,
          turnId: "",
        });

      assert(!nonStopResult, "non-Stop payload should not write a receipt");
      assert(!missingTurnResult, "missing turn id should not write a receipt");
      assert(
        completionReceipts.buildCodexCompletionReceiptKey({
          sessionId: "completion-missing-turn",
          turnId: "",
          eventName: "Stop",
        }) === "",
        "missing turn ids should produce an empty receipt key"
      );
      assert(
        !fs.existsSync(nonStopReceiptPath),
        "non-Stop payload should not create a completion receipt file"
      );
      assert(
        !completionReceipts.hasCodexCompletionReceipt({
          sessionId: nonStopSessionId,
          turnId: nonStopTurnId,
          eventName: "Stop",
        }),
        "non-Stop payload should not create a readable receipt"
      );
    } finally {
      deleteReceiptByKey(nonStopKey);
    }
  });

  test("turn-only legacy Codex Stop payload does not create a synthetic completion receipt", () => {
    const turnId = `turn-only-${process.pid}-${Date.now()}`;
    const syntheticKey = completionReceipts.buildCodexCompletionReceiptKey({
      sessionId: turnId,
      turnId,
      eventName: "Stop",
    });
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      client: "codex-cli",
      "turn-id": turnId,
    });
    const notification = normalizeIncomingNotification({
      argv: [payload],
      stdinData: "",
      env: {},
    });

    deleteReceiptByKey(syntheticKey);

    try {
      const wrote = completionReceipts.writeCodexCompletionReceiptForNotification(notification);

      assert(notification.sourceId === "codex-legacy-notify", "expected codex legacy notification");
      assert(notification.turnId === turnId, "expected turn id");
      assert(notification.sessionId === "unknown", "turn-only payload should not synthesize sessionId");
      assert(!wrote, "turn-only payload should not write a completion receipt");
      assert(
        !completionReceipts.hasCodexCompletionReceipt({
          sessionId: turnId,
          turnId,
          eventName: "Stop",
        }),
        "turn-only payload should not produce a synthetic receipt"
      );
    } finally {
      deleteReceiptByKey(syntheticKey);
    }
  });

  test("cli writes completion receipt before terminal detection runs", () => {
    const cli = require(path.join(ROOT, "bin", "cli.js"));
    const sessionId = `cli-order-session-${process.pid}-${Date.now()}`;
    const turnId = `cli-order-turn-${process.hrtime.bigint().toString()}`;
    const key = completionReceipts.buildCodexCompletionReceiptKey({
      sessionId,
      turnId,
      eventName: "Stop",
    });
    let receiptSeenDuringDetect = false;

    deleteReceiptByKey(key);

    try {
      cli.runDefaultNotifyMode([], {
        stdinData: "",
        normalizeIncomingNotificationImpl: () => ({
          sourceId: "codex-legacy-notify",
          source: "Codex",
          transport: "argv[0]",
          sessionId,
          turnId,
          eventName: "Stop",
          title: "Done",
          message: "Task finished",
          rawEventType: "agent-turn-complete",
          debugSummary: "test payload",
        }),
        createRuntimeImpl: () => ({
          buildInfo: { packageRoot: ROOT },
          isDev: true,
          logFile: path.join(notifyRuntime.LOG_DIR, `test-log-${Date.now()}.log`),
          logStem: `test-log-${Date.now()}`,
          log: () => {},
        }),
        detectTerminalContextImpl: () => {
          receiptSeenDuringDetect = completionReceipts.hasCodexCompletionReceipt({
            sessionId,
            turnId,
            eventName: "Stop",
          });
          return {
            hwnd: null,
            shellPid: null,
            isWindowsTerminal: false,
          };
        },
        emitNotificationImpl: () => ({
          on: () => {},
        }),
        exitProcessImpl: () => {},
      });

      assert(receiptSeenDuringDetect, "receipt should exist before terminal detection");
    } finally {
      deleteReceiptByKey(key);
    }
  });
};
