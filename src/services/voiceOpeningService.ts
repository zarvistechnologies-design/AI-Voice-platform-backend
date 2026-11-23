export type VoiceCallDirection = "web" | "inbound" | "outbound" | "";

type OpeningVariables = Record<string, string | undefined>;

function firstValue(variables: OpeningVariables, ...keys: string[]) {
  for (const key of keys) {
    const value = variables[key]?.trim();
    if (value) return value;
  }
  return "";
}

export function modelGeneratedOpeningInstructions(
  callDirection: VoiceCallDirection,
  variables: OpeningVariables,
) {
  const customerName = firstValue(
    variables,
    "full_name",
    "customer_name",
    "customerName",
    "LeadName",
  );
  const campaignName = firstValue(variables, "CampaignName", "campaignName");
  const campaignGoal = firstValue(
    variables,
    "CampaignGoal",
    "campaignGoal",
    "campaignScript",
  );
  const isCampaignFollowUp = firstValue(variables, "IsCampaignFollowUp", "isCampaignFollowUp").toLowerCase() === "true";
  const followUpReason = firstValue(variables, "FollowUpReason", "followUpReason");

  const common = [
    "Generate only the first spoken turn. Use one or two concise sentences and ask at most one question.",
    `The current call direction is ${callDirection || "unknown"}; treat it as authoritative.`,
    "Follow the matching direction-specific opening in the custom agent instructions when one is defined.",
  ];

  if (callDirection === "outbound") {
    return [
      ...common,
      "Use only the outbound opening. Do not use the inbound welcome or ask how you can help.",
      customerName
        ? `The intended recipient name supplied by the current campaign is ${JSON.stringify(customerName)}. Confirm that you are speaking with this person.`
        : "No usable recipient name is available. Use the custom prompt's unnamed outbound opening and do not invent a name.",
      campaignName ? `Campaign name: ${JSON.stringify(campaignName)}.` : "No campaign name is available.",
      campaignGoal ? `Campaign goal: ${JSON.stringify(campaignGoal)}.` : "No campaign goal is available.",
      ...(isCampaignFollowUp ? [
        "This is a planned follow-up to an earlier campaign call, not first outreach. After confirming identity and permission, briefly acknowledge the previous conversation and continue naturally.",
        followUpReason ? `The previous call outcome was ${JSON.stringify(followUpReason)}; use it only as internal context and do not read the label aloud.` : "The previous outcome label is unavailable; do not invent what was discussed.",
      ] : []),
      "Do not give the property pitch until the recipient confirms their identity and gives permission to continue.",
    ];
  }

  if (callDirection === "inbound") {
    return [
      ...common,
      "Use only the inbound welcome. Ask the caller's name unless they already gave it.",
      "Do not mention a campaign, advertisement, form, previous enquiry, or outbound calling purpose unless the caller mentions it first.",
    ];
  }

  return [
    ...common,
    "The call direction is unavailable or this is a web call. Use a neutral, help-first opening without claiming an enquiry or campaign.",
  ];
}
