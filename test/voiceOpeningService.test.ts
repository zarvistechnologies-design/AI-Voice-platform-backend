import assert from "node:assert/strict";
import test from "node:test";

import { modelGeneratedOpeningInstructions } from "../src/services/voiceOpeningService.js";

test("outbound generated opening receives the lead and campaign context", () => {
  const instructions = modelGeneratedOpeningInstructions("outbound", {
    full_name: "Aarav Sharma",
    CampaignName: "YEIDA outreach",
    CampaignGoal: "Qualify interest in available plots",
  }).join("\n");

  assert.match(instructions, /current call direction is outbound/i);
  assert.match(instructions, /Aarav Sharma/);
  assert.match(instructions, /YEIDA outreach/);
  assert.match(instructions, /Qualify interest in available plots/);
  assert.match(instructions, /Confirm that you are speaking with this person/i);
  assert.match(instructions, /permission to continue/i);
  assert.doesNotMatch(instructions, /Ask the caller's name unless/i);
});

test("outbound generated opening does not invent a missing lead name", () => {
  const instructions = modelGeneratedOpeningInstructions("outbound", {}).join("\n");

  assert.match(instructions, /No usable recipient name is available/i);
  assert.match(instructions, /do not invent a name/i);
});

test("inbound generated opening cannot leak campaign context", () => {
  const instructions = modelGeneratedOpeningInstructions("inbound", {
    full_name: "Historical Name",
    CampaignName: "Old campaign",
    CampaignGoal: "Old goal",
  }).join("\n");

  assert.match(instructions, /current call direction is inbound/i);
  assert.match(instructions, /Use only the inbound welcome/i);
  assert.match(instructions, /Do not mention a campaign/i);
  assert.doesNotMatch(instructions, /Historical Name|Old campaign|Old goal/);
});

test("unknown and web directions use a neutral opening", () => {
  for (const direction of ["", "web"] as const) {
    const instructions = modelGeneratedOpeningInstructions(direction, {}).join("\n");
    assert.match(instructions, /neutral, help-first opening/i);
    assert.match(instructions, /without claiming an enquiry or campaign/i);
  }
});
