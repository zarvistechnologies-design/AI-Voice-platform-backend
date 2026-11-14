import assert from "node:assert/strict";
import test from "node:test";

import {
  campaignFollowUpOutcomeIsEligible,
  eligibleCampaignFollowUpOutcomes,
} from "../src/services/campaignFollowUpPolicy.js";

test("all eligible follow-ups cover every safe campaign outcome", () => {
  assert.deepEqual(
    eligibleCampaignFollowUpOutcomes("all_eligible", ["follow_up"]),
    ["unknown", "qualified", "follow_up", "resolved", "missed"],
  );
  assert.equal(campaignFollowUpOutcomeIsEligible("all_eligible", [], "not_interested"), false);
});

test("selected-outcome follow-ups are filtered and deduplicated", () => {
  assert.deepEqual(
    eligibleCampaignFollowUpOutcomes("selected_outcomes", ["follow_up", "qualified", "follow_up", "not_interested"]),
    ["follow_up", "qualified"],
  );
  assert.equal(campaignFollowUpOutcomeIsEligible("selected_outcomes", ["follow_up"], "qualified"), false);
});
