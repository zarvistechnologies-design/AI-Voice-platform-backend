import assert from "node:assert/strict";

import { fallbackDurationSeconds } from "../src/services/callIntelligenceService.js";

const createdAt = new Date("2026-08-13T07:00:00.000Z");
const endedAt = new Date("2026-08-13T07:01:00.000Z");

assert.equal(
  fallbackDurationSeconds({ durationSeconds: 0, endedAt, ...({ createdAt } as object) }),
  0,
  "an unanswered one-minute dial attempt must remain zero seconds",
);

assert.equal(
  fallbackDurationSeconds({
    durationSeconds: 0,
    startedAt: new Date("2026-08-13T07:00:20.000Z"),
    endedAt,
  }),
  40,
  "an answered call must measure only time after answer",
);

assert.equal(
  fallbackDurationSeconds({ durationSeconds: 23, endedAt }),
  23,
  "an already persisted duration must not be replaced",
);

console.log("Call duration policy smoke test passed.");
