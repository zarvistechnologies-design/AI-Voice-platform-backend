export const campaignFollowUpAudiences = ["all_eligible", "selected_outcomes"] as const;
export type CampaignFollowUpAudience = typeof campaignFollowUpAudiences[number];

export const campaignFollowUpOutcomes = [
  "unknown",
  "qualified",
  "follow_up",
  "resolved",
  "missed",
] as const;
export type CampaignFollowUpOutcome = typeof campaignFollowUpOutcomes[number];

export function eligibleCampaignFollowUpOutcomes(
  audience: string,
  selectedOutcomes: readonly string[],
) {
  return audience === "all_eligible"
    ? [...campaignFollowUpOutcomes]
    : [...new Set(selectedOutcomes.filter((outcome): outcome is CampaignFollowUpOutcome =>
      campaignFollowUpOutcomes.includes(outcome as CampaignFollowUpOutcome),
    ))];
}

export function campaignFollowUpOutcomeIsEligible(
  audience: string,
  selectedOutcomes: readonly string[],
  outcome: string,
) {
  return eligibleCampaignFollowUpOutcomes(audience, selectedOutcomes).includes(
    outcome as CampaignFollowUpOutcome,
  );
}
