import assert from "node:assert/strict";
import test from "node:test";
import { callUsesFailedBranch } from "../src/services/automationCallBranch.js";

test("voice workflow routes missed and voicemail calls to the failed branch", () => {
  assert.equal(callUsesFailedBranch({ status: "completed" }, "missed"), true);
  assert.equal(callUsesFailedBranch({ status: "completed", voicemailDetected: true }, "unknown"), true);
  assert.equal(callUsesFailedBranch({ status: "failed" }, "unknown"), true);
  assert.equal(callUsesFailedBranch(null, "unknown"), true);
  assert.equal(callUsesFailedBranch({ status: "completed" }, "qualified"), false);
});
