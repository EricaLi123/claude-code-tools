#!/usr/bin/env node

const createHarness = require("./helpers/harness");

const harness = createHarness();

[
  require("./specs/structure-and-runtime.test"),
  require("./specs/sidecar.test"),
  require("./specs/approval-suppression.test"),
  require("./specs/codex-events.test"),
  require("./specs/notification-and-docs.test"),
  require("./specs/smoke.test"),
].forEach((runSuite) => runSuite(harness));

harness.finish();
