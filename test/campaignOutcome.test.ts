import assert from "node:assert/strict";
import test from "node:test";

import {
  campaignOutcomeCitation,
  inferOutcome,
  normalizedCampaignOutcome,
} from "../src/services/callIntelligenceService.js";

test("explicit rejection wins over positive topic words", () => {
  assert.equal(inferOutcome("I am not interested in the appointment"), "not_interested");
  assert.equal(inferOutcome("Do not call me about this demo"), "not_interested");
});

test("campaign outcome citations point to the caller evidence", () => {
  assert.deepEqual(
    campaignOutcomeCitation([
      { itemId: "a1", role: "assistant", text: "Would you like a call tomorrow?" },
      { itemId: "u1", role: "user", text: "Aap kal baat karna" },
    ], "follow_up"),
    { itemId: "u1", quote: "Aap kal baat karna" },
  );
  assert.deepEqual(
    campaignOutcomeCitation([{ itemId: "u2", role: "user", text: "Hello" }], "missed"),
    { itemId: "", quote: "" },
  );
});

test("failed booking stays a follow up instead of becoming qualified", () => {
  assert.equal(inferOutcome("The booking failed, call me tomorrow"), "follow_up");
  assert.equal(inferOutcome("Yes, I am interested in a demo"), "qualified");
  assert.equal(inferOutcome("We discussed the product"), null);
  assert.equal(inferOutcome("Aap kal baat karna"), "follow_up");
  assert.equal(inferOutcome("Mujhe interest nahi hai, call mat karna"), "not_interested");
});

test("campaign outcomes prefer confirmed structured and call signals", () => {
  assert.equal(
    normalizedCampaignOutcome({
      structuredOutput: { outcome: "appointment_booked" },
      tags: [],
      transcript: "",
      voicemailDetected: false,
      status: "completed",
      endReason: "",
    }),
    "qualified",
  );
  assert.equal(
    normalizedCampaignOutcome({
      structuredOutput: { outcome: "qualified" },
      tags: ["opt_out"],
      transcript: "",
      voicemailDetected: false,
      status: "completed",
      endReason: "",
    }),
    "not_interested",
  );
  assert.equal(
    normalizedCampaignOutcome({
      structuredOutput: {},
      tags: [],
      transcript: "",
      voicemailDetected: true,
      status: "completed",
      endReason: "",
    }),
    "missed",
  );
  assert.equal(
    normalizedCampaignOutcome({
      structuredOutput: {},
      tags: [],
      transcript: "Please call me back tomorrow morning",
      callbackRequested: true,
      voicemailDetected: false,
      status: "completed",
      endReason: "",
    }),
    "follow_up",
  );
});
