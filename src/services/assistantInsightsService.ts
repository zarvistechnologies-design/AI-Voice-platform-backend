import { Types } from "mongoose";

import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { CampaignLeadModel } from "../models/CampaignLead.js";
import { CampaignModel } from "../models/Campaign.js";
import { ContactSuppressionModel } from "../models/ContactSuppression.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { HttpError } from "../utils/httpError.js";
import { searchKnowledge } from "./knowledgeService.js";

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveCampaign(ownerId: string, identifier?: string) {
  const value = identifier?.trim() ?? "";
  const query = value
    ? Types.ObjectId.isValid(value)
      ? { _id: new Types.ObjectId(value), ownerId }
      : { ownerId, name: { $regex: escaped(value), $options: "i" } }
    : { ownerId };
  const campaign = await CampaignModel.findOne(query)
    .sort({ createdAt: -1 })
    .select("name status goal successCriteria totalLeads startedAt completedAt createdAt followUpEnabled")
    .lean();
  if (!campaign) throw new HttpError(404, value ? `No campaign matching '${value}' was found.` : "No campaigns were found in this workspace.");
  return campaign;
}

export async function listAssistantCampaigns(ownerId: string) {
  const campaigns = await CampaignModel.find({ ownerId })
    .sort({ createdAt: -1 })
    .limit(12)
    .select("name status totalLeads createdAt startedAt completedAt goal")
    .lean();
  return campaigns.map((campaign) => ({
    id: String(campaign._id), name: campaign.name, status: campaign.status,
    totalLeads: campaign.totalLeads, goal: campaign.goal,
    startedAt: campaign.startedAt, completedAt: campaign.completedAt,
    url: `/dashboard/campaign/${campaign._id}`,
  }));
}

export async function getAssistantCampaignPerformance(ownerId: string, identifier?: string) {
  const campaign = await resolveCampaign(ownerId, identifier);
  const [leadGroups, callGroups, failures] = await Promise.all([
    CampaignLeadModel.aggregate<{ _id: { outcome: string; status: string }; count: number }>([
      { $match: { ownerId, campaignId: campaign._id } },
      { $group: { _id: { outcome: "$outcome", status: "$status" }, count: { $sum: 1 } } },
    ]),
    CallDetailRecordModel.aggregate<{ _id: string; count: number }>([
      { $match: { campaignId: campaign._id, $or: [{ ownerId }, { orgId: ownerId }] } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    CallDetailRecordModel.find({ campaignId: campaign._id, $or: [{ ownerId }, { orgId: ownerId }], status: "failed" })
      .sort({ createdAt: -1 }).limit(5)
      .select("endReason errorMessage createdAt campaignLeadId")
      .lean(),
  ]);
  const outcomes: Record<string, number> = {};
  const leadStatuses: Record<string, number> = {};
  for (const group of leadGroups) {
    const outcome = group._id.outcome || "unknown";
    const status = group._id.status || "unknown";
    outcomes[outcome] = (outcomes[outcome] ?? 0) + group.count;
    leadStatuses[status] = (leadStatuses[status] ?? 0) + group.count;
  }
  const callStatuses = Object.fromEntries(callGroups.map((group) => [group._id || "unknown", group.count]));
  return {
    campaign: { id: String(campaign._id), name: campaign.name, status: campaign.status, goal: campaign.goal,
      successCriteria: campaign.successCriteria, totalLeads: campaign.totalLeads, startedAt: campaign.startedAt,
      completedAt: campaign.completedAt, url: `/dashboard/campaign/${campaign._id}` },
    outcomes, leadStatuses, callStatuses,
    recentFailures: failures.map((call) => ({
      callId: String(call._id), leadId: call.campaignLeadId ? String(call.campaignLeadId) : null,
      reason: call.endReason || call.errorMessage || "Unknown failure", date: call.createdAt,
    })),
    note: "Counts come from stored campaign leads and calls. Unknown outcomes have not been classified.",
  };
}

export async function getAssistantFollowUpCandidates(ownerId: string, identifier?: string) {
  const campaign = identifier ? await resolveCampaign(ownerId, identifier) : null;
  const query = {
    ownerId,
    ...(campaign ? { campaignId: campaign._id } : {}),
    outcome: { $in: ["follow_up", "qualified"] },
    status: { $nin: ["suppressed", "cancelled"] },
    callbackStatus: { $nin: ["scheduled", "calling", "completed", "retry_wait"] },
    followUpStatus: { $nin: ["scheduled", "calling", "completed"] },
    conversionStatus: { $nin: ["pending", "verified"] },
  };
  const [leads, total] = await Promise.all([
    CampaignLeadModel.find(query)
      .sort({ outcomeUpdatedAt: -1, lastAttemptAt: -1, _id: -1 })
      .limit(60)
      .select("campaignId name phone company outcome outcomeEvidence outcomeEvidenceQuote status lastError lastAttemptAt callbackStatus callbackScheduledFor qaScore")
      .lean(),
    CampaignLeadModel.countDocuments(query),
  ]);
  const [campaigns, suppressions] = await Promise.all([
    CampaignModel.find({ ownerId, _id: { $in: [...new Set(leads.map((lead) => String(lead.campaignId)))] } }).select("name status timezone windowStart windowEnd automaticCallbacks").lean(),
    ContactSuppressionModel.find({ ownerId, phone: { $in: leads.map((lead) => lead.phone) } }).select("phone").lean(),
  ]);
  const suppressedPhones = new Set(suppressions.map((item) => item.phone));
  const byId = new Map(campaigns.map((item) => [String(item._id), item]));
  return {
    matchedBeforeOptOutCheck: total,
    candidates: leads.filter((lead) => !suppressedPhones.has(lead.phone)).slice(0, 20).map((lead) => ({
      leadId: String(lead._id), campaignId: String(lead.campaignId),
      campaign: byId.get(String(lead.campaignId))?.name ?? "Campaign",
      campaignStatus: byId.get(String(lead.campaignId))?.status ?? "unknown",
      timezone: byId.get(String(lead.campaignId))?.timezone ?? "UTC",
      callingWindow: `${byId.get(String(lead.campaignId))?.windowStart ?? "09:00"}-${byId.get(String(lead.campaignId))?.windowEnd ?? "18:00"}`,
      callbackEnabled: byId.get(String(lead.campaignId))?.automaticCallbacks ?? false,
      name: lead.name || "Unnamed contact", phone: lead.phone, company: lead.company,
      outcome: lead.outcome, evidence: lead.outcomeEvidenceQuote || "",
      evidenceQuality: lead.outcomeEvidence, lastAttemptAt: lead.lastAttemptAt,
      lastError: lead.lastError || "", qaScore: lead.qaScore,
      url: `/dashboard/campaign/${lead.campaignId}`,
    })),
    note: "Known opt-outs are excluded. These contacts still need consent and campaign-window review before scheduling a call.",
  };
}

export async function getAssistantAgentPerformance(ownerId: string, identifier: string, days: number) {
  const agent = await VoiceAgentModel.findOne(
    Types.ObjectId.isValid(identifier)
      ? { _id: new Types.ObjectId(identifier), ownerId }
      : { ownerId, name: { $regex: escaped(identifier.trim()), $options: "i" } },
  ).select("name status language updatedAt").lean();
  if (!agent) throw new HttpError(404, `No voice agent matching '${identifier}' was found.`);
  const from = new Date(Date.now() - days * 24 * 60 * 60_000);
  const filter = { agentId: agent._id, createdAt: { $gte: from }, $or: [{ ownerId }, { orgId: ownerId }] };
  const [groups, failures] = await Promise.all([
    CallDetailRecordModel.aggregate<{ _id: string; count: number; averageDurationSeconds: number; averageResponseLatencyMs: number }>([
      { $match: filter },
      { $group: { _id: "$status", count: { $sum: 1 }, averageDurationSeconds: { $avg: "$durationSeconds" },
        averageResponseLatencyMs: { $avg: "$avgResponseLatencyMs" } } },
    ]),
    CallDetailRecordModel.find({ ...filter, status: "failed" }).sort({ createdAt: -1 }).limit(5)
      .select("endReason errorMessage createdAt")
      .lean(),
  ]);
  return {
    agent: { id: String(agent._id), name: agent.name, status: agent.status, language: agent.language,
      url: `/dashboard/agents/${agent._id}` },
    days, statuses: Object.fromEntries(groups.map((group) => [group._id || "unknown", group.count])),
    averageDurationSeconds: Math.round(groups.reduce((sum, group) => sum + (group.averageDurationSeconds || 0) * group.count, 0)
      / Math.max(1, groups.reduce((sum, group) => sum + group.count, 0))),
    averageResponseLatencyMs: Math.round(groups.reduce((sum, group) => sum + (group.averageResponseLatencyMs || 0) * group.count, 0)
      / Math.max(1, groups.reduce((sum, group) => sum + group.count, 0))),
    recentFailureReasons: failures.map((call) => ({ callId: String(call._id), reason: call.endReason || call.errorMessage || "Unknown failure" })),
    note: "Recommendations should be based on these observations; a failed call may also be caused by the carrier or caller.",
  };
}

export async function searchAssistantKnowledge(ownerId: string, identifier: string, query: string) {
  const agent = await VoiceAgentModel.findOne(
    Types.ObjectId.isValid(identifier)
      ? { _id: new Types.ObjectId(identifier), ownerId }
      : { ownerId, name: { $regex: escaped(identifier.trim()), $options: "i" } },
  ).select("name").lean();
  if (!agent) throw new HttpError(404, `No voice agent matching '${identifier}' was found.`);
  const results = await searchKnowledge({ ownerId, agentId: agent._id, query, limit: 4, embeddingTimeoutMs: 2500, fallbackMaxChunks: 100 });
  return { agent: agent.name, results: results.map((result) => ({
    source: result.sourceName, sourceId: result.sourceId, excerpt: result.content.slice(0, 1400), score: result.score,
  })) };
}
