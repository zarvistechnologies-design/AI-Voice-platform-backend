import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { isValidObjectId, startSession } from "mongoose";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { AgentCampaignSlotModel } from "../models/AgentCampaignSlot.js";
import { CampaignLeadModel } from "../models/CampaignLead.js";
import { CampaignBusinessEventModel } from "../models/CampaignBusinessEvent.js";
import { CampaignModel, type CampaignDocument } from "../models/Campaign.js";
import { ContactSuppressionModel } from "../models/ContactSuppression.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { PhoneNumberCallAdmissionModel } from "../models/PhoneNumberCallAdmission.js";
import { ScheduledCallbackModel } from "../models/ScheduledCallback.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { HttpError } from "../utils/httpError.js";
import { normalizeE164 } from "../utils/phoneNumber.js";
import {
  releaseTerminalFinalizationDeferral,
  transitionCallToCancelled,
} from "../services/callRecordService.js";
import { endCallRooms } from "../services/livekitService.js";
import { backfillCampaignOutcomes, finalizeCallIntelligence } from "../services/callIntelligenceService.js";
import { recordHumanBusinessEvent } from "../services/campaignBusinessEventService.js";

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const campaignStatuses = ["draft", "scheduled", "running", "paused", "completed", "cancelled", "failed"];
const leadStatuses = ["queued", "leased", "active", "completed", "retry_wait", "failed", "suppressed", "cancelled"];
const campaignOutcomes = ["unknown", "qualified", "follow_up", "resolved", "missed", "not_interested"];
const callbackStatuses = ["", "scheduled", "calling", "completed", "retry_wait", "needs_attention", "cancelled"];
const conversionTypes = ["appointment", "booking", "payment", "revenue", "lead", "other"] as const;
const conversionStatuses = ["pending", "verified", "rejected", "refunded"] as const;

type ScorecardWeights = {
  enabled: boolean;
  connectionWeight: number;
  outcomeWeight: number;
  goalWeight: number;
  followUpWeight: number;
};

function scorecardWeights(campaign: CampaignDocument): ScorecardWeights {
  return {
    enabled: campaign.scorecard?.enabled !== false,
    connectionWeight: Number(campaign.scorecard?.connectionWeight ?? 20),
    outcomeWeight: Number(campaign.scorecard?.outcomeWeight ?? 20),
    goalWeight: Number(campaign.scorecard?.goalWeight ?? 40),
    followUpWeight: Number(campaign.scorecard?.followUpWeight ?? 20),
  };
}

function qaForLead(
  lead: Record<string, unknown>,
  latestCall: Record<string, unknown> | null,
  weights: ScorecardWeights,
) {
  const outcome = String(lead.outcome ?? "unknown");
  const checks = {
    connected: Boolean(latestCall?.startedAt),
    outcomeClassified: outcome !== "unknown",
    goalReached: ["qualified", "resolved"].includes(outcome) || lead.conversionStatus === "verified",
    followUpHandled: outcome !== "follow_up" || ["scheduled", "calling", "completed"].includes(String(lead.callbackStatus ?? "")),
  };
  const score = weights.enabled ? Math.round(
    (checks.connected ? weights.connectionWeight : 0) +
    (checks.outcomeClassified ? weights.outcomeWeight : 0) +
    (checks.goalReached ? weights.goalWeight : 0) +
    (checks.followUpHandled ? weights.followUpWeight : 0),
  ) : 0;
  const grade = !weights.enabled ? "" : score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
  return { score, grade, checks };
}

function ownerId(request: AuthenticatedRequest) {
  if (!request.user || !request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

function cleanText(value: unknown, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

function safeTimezone(value: unknown) {
  const timezone = cleanText(value, 100) || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw new HttpError(400, "Choose a valid IANA timezone.");
  }
}

function safeTime(value: unknown, fallback: string) {
  const time = cleanText(value, 5) || fallback;
  if (!timePattern.test(time)) throw new HttpError(400, "Call windows must use HH:mm format.");
  return time;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function truthy(value: unknown) {
  return value === true || ["1", "true", "yes", "y", "optout", "optedout"].includes(String(value ?? "").trim().toLowerCase());
}

function escapeRegex(value: string) {
  const special = "\\^$.*+?()[]{}|";
  return value
    .split("")
    .map((character) => special.includes(character) ? "\\" + character : character)
    .join("");
}

function campaignLeadQuery(
  campaignId: unknown,
  query: AuthenticatedRequest["query"],
) {
  const status = cleanText(query.status, 30);
  const outcome = cleanText(query.outcome, 30);
  const callbackStatus = cleanText(query.callbackStatus, 30);
  if (status && !leadStatuses.includes(status)) throw new HttpError(400, "Invalid lead status.");
  if (outcome && !campaignOutcomes.includes(outcome)) throw new HttpError(400, "Invalid campaign outcome.");
  if (callbackStatus && !callbackStatuses.includes(callbackStatus)) {
    throw new HttpError(400, "Invalid callback status.");
  }
  const filter: Record<string, unknown> = {
    campaignId,
    ...(status ? { status } : {}),
    ...(outcome ? { outcome } : {}),
    ...(callbackStatus ? { callbackStatus } : {}),
  };
  const search = cleanText(query.search, 120);
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: pattern }, { phone: pattern }, { email: pattern }, { company: pattern }];
  }
  return filter;
}

async function enrichCampaignLeads(leads: Record<string, unknown>[], weights?: ScorecardWeights) {
  if (!leads.length) return [];
  const leadIds = leads.map((lead) => lead._id);
  const [calls, callbacks] = await Promise.all([
    CallDetailRecordModel.find({ campaignLeadId: { $in: leadIds } })
      .sort({ createdAt: -1 })
      .select(
        "_id campaignLeadId status startedAt endedAt createdAt durationSeconds endReason errorMessage " +
        "voicemailDetected sentimentLabel structuredOutput tags costBreakdown.customerCost costBreakdown.currency",
      )
      .lean(),
    ScheduledCallbackModel.find({ campaignLeadId: { $in: leadIds } })
      .sort({ createdAt: -1 })
      .select(
        "_id campaignLeadId status scheduledFor timezone attemptCount maxAttempts lastAttemptAt completedAt lastError reason",
      )
      .lean(),
  ]);
  const callsByLead = new Map<string, typeof calls>();
  for (const call of calls) {
    const key = String(call.campaignLeadId);
    const current = callsByLead.get(key) ?? [];
    current.push(call);
    callsByLead.set(key, current);
  }
  const callbackByLead = new Map<string, (typeof callbacks)[number]>();
  for (const callback of callbacks) {
    const key = String(callback.campaignLeadId);
    if (!callbackByLead.has(key)) callbackByLead.set(key, callback);
  }
  return leads.map((lead) => {
    const attempts = callsByLead.get(String(lead._id)) ?? [];
    const latestCall = attempts[0] ?? null;
    const qa = weights ? qaForLead(lead, latestCall as Record<string, unknown> | null, weights) : null;
    return {
      ...lead,
      attempts: attempts.length,
      latestCall,
      callback: callbackByLead.get(String(lead._id)) ?? null,
      ...(qa ? { qaScore: qa.score, qaGrade: qa.grade, qaChecks: qa.checks } : {}),
    };
  });
}

function escapeCsv(value: unknown) {
  return '"' + String(value ?? "").replaceAll('"', '""') + '"';
}

function safeCustomFields(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([rawKey, rawValue]) => [
        rawKey.trim().replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80),
        cleanText(rawValue, 500),
      ])
      .filter(([key, item]) => key && item)
      .slice(0, 40),
  );
}

function leadRequestsOptOut(lead: Record<string, unknown>, customFields: Record<string, string>) {
  if (truthy(lead.doNotCall) || truthy(lead.optOut)) return true;
  const normalized = Object.fromEntries(
    Object.entries(customFields).map(([key, value]) => [key.toLowerCase().replace(/_/g, ""), value]),
  );
  return ["dnc", "donotcall", "optout", "unsubscribed"].some((key) => truthy(normalized[key]));
}

async function findCampaign(request: AuthenticatedRequest, includeLease = false) {
  if (!isValidObjectId(request.params.campaignId)) throw new HttpError(400, "Valid campaignId is required.");
  const query = CampaignModel.findOne({ _id: request.params.campaignId, ownerId: ownerId(request) });
  if (includeLease) query.select("+leaseToken +leasedUntil");
  const campaign = await query;
  if (!campaign) throw new HttpError(404, "Campaign not found.");
  return campaign;
}

async function campaignCounts(campaignIds: unknown[]) {
  if (!campaignIds.length) return new Map<string, Record<string, number>>();
  const groups = await CampaignLeadModel.aggregate<{ _id: { campaignId: unknown; status: string }; count: number }>([
    { $match: { campaignId: { $in: campaignIds } } },
    { $group: { _id: { campaignId: "$campaignId", status: "$status" }, count: { $sum: 1 } } },
  ]);
  const result = new Map<string, Record<string, number>>();
  for (const group of groups) {
    const id = String(group._id.campaignId);
    const counts = result.get(id) ?? Object.fromEntries(leadStatuses.map((status) => [status, 0]));
    counts[group._id.status] = group.count;
    result.set(id, counts);
  }
  return result;
}

function serializeCampaign(campaign: CampaignDocument, counts: Record<string, number> = {}) {
  const raw = campaign.toObject();
  delete (raw as Record<string, unknown>).idempotencyKey;
  delete (raw as Record<string, unknown>).leaseToken;
  delete (raw as Record<string, unknown>).leasedUntil;
  const normalizedCounts = Object.fromEntries(leadStatuses.map((status) => [status, counts[status] ?? 0]));
  const terminal = normalizedCounts.completed + normalizedCounts.failed + normalizedCounts.suppressed + normalizedCounts.cancelled;
  return {
    ...raw,
    _id: campaign.id,
    stats: {
      ...normalizedCounts,
      total: campaign.totalLeads,
      processed: terminal,
      progressPercent: campaign.totalLeads ? Math.round((terminal / campaign.totalLeads) * 1000) / 10 : 0,
    },
  };
}

export async function createCampaign(request: AuthenticatedRequest, response: Response) {
  const orgId = ownerId(request);
  const body = (request.body ?? {}) as Record<string, unknown>;
  const name = cleanText(body.name, 160);
  if (!name) throw new HttpError(400, "Campaign name is required.");
  if (!isValidObjectId(body.agentId) || !isValidObjectId(body.phoneNumberId)) {
    throw new HttpError(400, "Valid agentId and phoneNumberId are required.");
  }
  if (body.respectDnc === false || body.requireConsentLine === false) {
    throw new HttpError(400, "Opt-out suppression and a consent opening are required for outbound campaigns.");
  }
  const [agent, phone] = await Promise.all([
    VoiceAgentModel.findOne({ _id: body.agentId, ownerId: orgId, status: "Live" }),
    PhoneNumberModel.findOne({
      _id: body.phoneNumberId,
      ownerId: orgId,
      agentId: body.agentId,
      status: "Ready",
      direction: { $in: ["Outbound", "Both"] },
      lifecycle: { $ne: "deleting" },
    }),
  ]);
  if (!agent) throw new HttpError(409, "The selected campaign agent must be Live.");
  if (!phone) throw new HttpError(409, "The selected caller ID must be Ready and assigned to this agent.");

  const idempotencyKey = cleanText(request.get("idempotency-key") || body.idempotencyKey, 160) || randomUUID();
  const existing = await CampaignModel.findOne({ ownerId: orgId, idempotencyKey });
  if (existing) {
    response.json({ campaign: serializeCampaign(existing) });
    return;
  }

  const campaign = await CampaignModel.create({
    ownerId: orgId,
    createdBy: request.user!.id,
    idempotencyKey,
    name,
    agentId: agent._id,
    phoneNumberId: phone._id,
    timezone: safeTimezone(body.timezone),
    windowStart: safeTime(body.windowStart, "09:00"),
    windowEnd: safeTime(body.windowEnd, "18:00"),
    dailyLimit: boundedInteger(body.dailyLimit, 250, 1, 100000),
    concurrency: Math.min(
      agent.maxConcurrentCalls,
      boundedInteger(body.concurrency, 3, 1, 100),
    ),
    maxAttempts: boundedInteger(body.maxAttempts, 1, 1, 10),
    retryGapSeconds: boundedInteger(body.retryGapSeconds, 86400, 60, 2592000),
    goal: cleanText(body.goal, 2000),
    successCriteria: cleanText(body.successCriteria, 2000),
    respectDnc: true,
    requireConsentLine: true,
    detectVoicemail: booleanValue(body.detectVoicemail, true),
    automaticCallbacks: booleanValue(body.automaticCallbacks, true),
  });
  response.status(201).json({ campaign: serializeCampaign(campaign) });
}

export async function addCampaignLeads(request: AuthenticatedRequest, response: Response) {
  const campaign = await findCampaign(request);
  if (campaign.status !== "draft") throw new HttpError(409, "Leads can only be added while a campaign is a draft.");
  const leads = Array.isArray(request.body?.leads) ? request.body.leads as Record<string, unknown>[] : [];
  if (!leads.length || leads.length > 500) throw new HttpError(400, "Upload between 1 and 500 leads per request.");

  const sanitized = leads.map((lead, index) => {
    const phone = normalizeE164(cleanText(lead.phone, 40));
    if (!phone) {
      throw new HttpError(400, `Lead ${index + 1} must include an international country code.`);
    }
    const customFields = safeCustomFields(lead.customFields);
    return {
      row: boundedInteger(lead.row, index + 1, 1, 10_000_000),
      phone,
      name: cleanText(lead.name, 300),
      email: cleanText(lead.email, 320),
      company: cleanText(lead.company, 300),
      customFields,
      requestedOptOut: leadRequestsOptOut(lead, customFields),
    };
  });
  // One deterministic operation per phone avoids unordered upserts racing each
  // other. Keep the first row's contact data, but never let a later duplicate
  // erase an opt-out signal.
  const uniqueLeadByPhone = new Map<string, (typeof sanitized)[number]>();
  for (const lead of sanitized) {
    const existing = uniqueLeadByPhone.get(lead.phone);
    if (!existing) {
      uniqueLeadByPhone.set(lead.phone, lead);
    } else if (lead.requestedOptOut && !existing.requestedOptOut) {
      uniqueLeadByPhone.set(lead.phone, { ...existing, requestedOptOut: true });
    }
  }
  const uniqueLeads = [...uniqueLeadByPhone.values()];
  const suppressions = await ContactSuppressionModel.find({
    ownerId: campaign.ownerId,
    phone: { $in: uniqueLeads.map((lead) => lead.phone) },
  }).select("phone reason");
  const suppressionByPhone = new Map(suppressions.map((item) => [item.phone, item.reason]));

  const operations = uniqueLeads.map((lead) => {
    const suppressionReason = lead.requestedOptOut
      ? "Contact is marked as opted out in the import."
      : suppressionByPhone.get(lead.phone) ?? "";
    const insertFields = {
      ownerId: campaign.ownerId,
      campaignId: campaign._id,
      row: lead.row,
      phone: lead.phone,
      name: lead.name,
      email: lead.email,
      company: lead.company,
      customFields: lead.customFields,
    };
    return {
      updateOne: {
        filter: { campaignId: campaign._id, phone: lead.phone },
        update: suppressionReason
          ? {
              $setOnInsert: insertFields,
              // A later opt-out import must also suppress a lead that was
              // already queued in this draft campaign.
              $set: {
                status: "suppressed" as const,
                suppressionReason,
              },
            }
          : {
              $setOnInsert: {
                ...insertFields,
                status: "queued" as const,
                suppressionReason: "",
              },
            },
        upsert: true,
      },
    };
  });

  const importSession = await startSession();
  let importResult: { inserted: number; total: number; suppressed: number } | undefined;
  try {
    importResult = await importSession.withTransaction(async () => {
      const fence = await CampaignModel.updateOne(
        {
          _id: campaign._id,
          ownerId: campaign.ownerId,
          status: "draft",
          cancellationRequestedAt: null,
        },
        { $set: { leadImportFence: randomUUID() } },
        { session: importSession },
      );
      if (fence.matchedCount !== 1) {
        throw new HttpError(409, "The campaign changed while leads were being imported. Refresh and retry.");
      }

      const result = await CampaignLeadModel.bulkWrite(
        operations,
        { ordered: false, session: importSession },
      );
      // MongoDB does not support parallel operations on the same transaction session.
      const total = await CampaignLeadModel.countDocuments({ campaignId: campaign._id }).session(importSession);
      const suppressed = await CampaignLeadModel.countDocuments({
        campaignId: campaign._id,
        status: "suppressed",
      }).session(importSession);
      const totalUpdate = await CampaignModel.updateOne(
        { _id: campaign._id, status: "draft", cancellationRequestedAt: null },
        { $set: { totalLeads: total } },
        { session: importSession },
      );
      if (totalUpdate.matchedCount !== 1) {
        throw new HttpError(409, "The campaign changed while leads were being imported. Refresh and retry.");
      }
      return { inserted: result.upsertedCount, total, suppressed };
    });
  } finally {
    await importSession.endSession();
  }
  if (!importResult) {
    throw new Error("Lead import transaction completed without a result.");
  }
  response.status(201).json({
    inserted: importResult.inserted,
    duplicates: leads.length - importResult.inserted,
    total: importResult.total,
    suppressed: importResult.suppressed,
  });
}

export async function launchCampaign(request: AuthenticatedRequest, response: Response) {
  const campaign = await findCampaign(request);
  if (["scheduled", "running", "paused"].includes(campaign.status)) {
    const counts = await campaignCounts([campaign._id]);
    response.json({ campaign: serializeCampaign(campaign, counts.get(campaign.id)) });
    return;
  }
  if (campaign.status !== "draft") throw new HttpError(409, `A ${campaign.status} campaign cannot be launched.`);
  const callable = await CampaignLeadModel.countDocuments({ campaignId: campaign._id, status: "queued" });
  if (!callable) throw new HttpError(409, "Campaign has no callable leads after suppression checks.");

  const mode = request.body?.mode === "schedule" ? "schedule" : "now";
  let scheduledAt: Date | null = null;
  if (mode === "schedule") {
    scheduledAt = new Date(request.body?.scheduledAt);
    if (!Number.isFinite(scheduledAt.getTime())) throw new HttpError(400, "A valid scheduledAt timestamp is required.");
  }
  const now = new Date();
  const nextStatus = scheduledAt && scheduledAt > now ? "scheduled" : "running";
  const launched = await CampaignModel.findOneAndUpdate(
    { _id: campaign._id, ownerId: campaign.ownerId, status: "draft", cancellationRequestedAt: null },
    {
      $set: {
        status: nextStatus,
        scheduledAt,
        startedAt: nextStatus === "running" ? now : null,
      },
    },
    { new: true },
  );
  if (!launched) throw new HttpError(409, "The campaign changed before it could be launched. Refresh and retry.");
  const counts = await campaignCounts([launched._id]);
  response.json({ campaign: serializeCampaign(launched, counts.get(launched.id)) });
}

export async function listCampaigns(request: AuthenticatedRequest, response: Response) {
  const status = cleanText(request.query.status, 30);
  if (status && !campaignStatuses.includes(status)) throw new HttpError(400, "Invalid campaign status.");
  const campaigns = await CampaignModel.find({ ownerId: ownerId(request), ...(status ? { status } : {}) })
    .sort({ createdAt: -1 })
    .limit(boundedInteger(request.query.limit, 50, 1, 100));
  const counts = await campaignCounts(campaigns.map((campaign) => campaign._id));
  response.json({ campaigns: campaigns.map((campaign) => serializeCampaign(campaign, counts.get(campaign.id))) });
}

export async function getCampaign(request: AuthenticatedRequest, response: Response) {
  const campaign = await findCampaign(request);
  const counts = await campaignCounts([campaign._id]);
  response.json({ campaign: serializeCampaign(campaign, counts.get(campaign.id)) });
}

export async function listCampaignLeads(request: AuthenticatedRequest, response: Response) {
  const campaign = await findCampaign(request);
  const limit = boundedInteger(request.query.limit, 100, 1, 500);
  const page = boundedInteger(request.query.page, 1, 1, 100000);
  const query = campaignLeadQuery(campaign._id, request.query);
  const [leads, total] = await Promise.all([
    CampaignLeadModel.find(query).sort({ row: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    CampaignLeadModel.countDocuments(query),
  ]);
  response.json({ leads: await enrichCampaignLeads(leads, scorecardWeights(campaign)), page, limit, total });
}

export async function reviewCampaignLeadOutcome(
  request: AuthenticatedRequest,
  response: Response,
) {
  const campaign = await findCampaign(request);
  if (!isValidObjectId(request.params.leadId)) {
    throw new HttpError(400, "Valid leadId is required.");
  }
  const outcome = cleanText(request.body?.outcome, 30);
  if (!campaignOutcomes.includes(outcome)) {
    throw new HttpError(400, "Choose a valid campaign outcome.");
  }
  const lead = await CampaignLeadModel.findOneAndUpdate(
    {
      _id: request.params.leadId,
      campaignId: campaign._id,
      ownerId: campaign.ownerId,
    },
    {
      $set: {
        outcome,
        outcomeEvidence: "human_reviewed",
        outcomeReviewNote: cleanText(request.body?.note, 500),
        outcomeReviewedBy: request.user!.id,
        outcomeUpdatedAt: new Date(),
        outcomeEvidenceQuote: cleanText(request.body?.note, 500),
        outcomeEvidenceItemId: "",
      },
    },
    { new: true, runValidators: true },
  ).lean();
  if (!lead) throw new HttpError(404, "Campaign contact not found.");
  response.json({ lead });
}

export async function updateCampaignScorecard(
  request: AuthenticatedRequest,
  response: Response,
) {
  const campaign = await findCampaign(request);
  const scorecard: ScorecardWeights = {
    enabled: booleanValue(request.body?.enabled, true),
    connectionWeight: boundedInteger(request.body?.connectionWeight, 20, 0, 100),
    outcomeWeight: boundedInteger(request.body?.outcomeWeight, 20, 0, 100),
    goalWeight: boundedInteger(request.body?.goalWeight, 40, 0, 100),
    followUpWeight: boundedInteger(request.body?.followUpWeight, 20, 0, 100),
  };
  const totalWeight = scorecard.connectionWeight + scorecard.outcomeWeight + scorecard.goalWeight + scorecard.followUpWeight;
  if (scorecard.enabled && totalWeight !== 100) {
    throw new HttpError(400, "Enabled scorecard weights must total 100.");
  }
  campaign.scorecard = scorecard;
  await campaign.save();
  response.json({ scorecard });
}

export async function reanalyzeCampaign(
  request: AuthenticatedRequest,
  response: Response,
) {
  const campaign = await findCampaign(request);
  const limit = boundedInteger(request.body?.limit, 50, 1, 100);
  const calls = await CallDetailRecordModel.find({
    campaignId: campaign._id,
    ownerId: campaign.ownerId,
    status: { $in: ["completed", "failed", "cancelled"] },
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select("livekitRoomName")
    .lean();
  const results: PromiseSettledResult<unknown>[] = [];
  for (let index = 0; index < calls.length; index += 5) {
    results.push(...await Promise.allSettled(
      calls.slice(index, index + 5).map((call) => finalizeCallIntelligence(call.livekitRoomName)),
    ));
  }
  const failures = results.filter((result) => result.status === "rejected").length;
  response.json({
    analyzed: results.length - failures,
    failed: failures,
    limited: calls.length === limit,
  });
}

export async function recordCampaignLeadConversion(
  request: AuthenticatedRequest,
  response: Response,
) {
  const campaign = await findCampaign(request);
  if (!isValidObjectId(request.params.leadId)) throw new HttpError(400, "Valid leadId is required.");
  const lead = await CampaignLeadModel.findOne({
    _id: request.params.leadId,
    campaignId: campaign._id,
    ownerId: campaign.ownerId,
  }).select("_id");
  if (!lead) throw new HttpError(404, "Campaign contact not found.");
  const type = cleanText(request.body?.type, 30) as typeof conversionTypes[number];
  const status = cleanText(request.body?.status, 30) as typeof conversionStatuses[number];
  if (!conversionTypes.includes(type)) throw new HttpError(400, "Choose a valid conversion type.");
  if (!conversionStatuses.includes(status)) throw new HttpError(400, "Choose a valid conversion status.");
  const amount = Number(request.body?.amount ?? 0);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) {
    throw new HttpError(400, "Conversion amount must be a valid non-negative number.");
  }
  const externalId = cleanText(request.body?.externalId, 300);
  if (status === "verified" && ["payment", "revenue"].includes(type) && !externalId) {
    throw new HttpError(400, "Verified payments and revenue require an external reference.");
  }
  const currency = (cleanText(request.body?.currency, 10) || "USD").toUpperCase();
  if (!/^[A-Z]{3,10}$/.test(currency)) throw new HttpError(400, "Use a valid currency code.");
  const event = await recordHumanBusinessEvent({
    ownerId: campaign.ownerId,
    userId: request.user!.id,
    campaignId: campaign._id,
    campaignLeadId: lead._id,
    type,
    status,
    amount,
    currency,
    externalId,
    note: cleanText(request.body?.note, 300),
  });
  response.status(201).json({ event });
}

export async function getCampaignResults(request: AuthenticatedRequest, response: Response) {
  const campaign = await findCampaign(request);
  await backfillCampaignOutcomes(campaign._id, campaign.ownerId);
  const weights = scorecardWeights(campaign);
  const [leadGroups, callGroups, contactCallGroups, eventGroups, revenueGroups, callTimeline, outcomeTimeline] = await Promise.all([
    CampaignLeadModel.aggregate<{
      _id: null;
      total: number;
      classified: number;
      qualified: number;
      followUp: number;
      resolved: number;
      missed: number;
      notInterested: number;
      callbacksScheduled: number;
      callbacksCalling: number;
      callbacksCompleted: number;
      callbacksNeedAttention: number;
      conversionsVerified: number;
      crmSynced: number;
      crmFailed: number;
    }>([
      { $match: { campaignId: campaign._id } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          classified: { $sum: { $cond: [{ $ne: [{ $ifNull: ["$outcome", "unknown"] }, "unknown"] }, 1, 0] } },
          qualified: { $sum: { $cond: [{ $eq: ["$outcome", "qualified"] }, 1, 0] } },
          followUp: { $sum: { $cond: [{ $eq: ["$outcome", "follow_up"] }, 1, 0] } },
          resolved: { $sum: { $cond: [{ $eq: ["$outcome", "resolved"] }, 1, 0] } },
          missed: { $sum: { $cond: [{ $eq: ["$outcome", "missed"] }, 1, 0] } },
          notInterested: { $sum: { $cond: [{ $eq: ["$outcome", "not_interested"] }, 1, 0] } },
          callbacksScheduled: { $sum: { $cond: [{ $in: ["$callbackStatus", ["scheduled", "retry_wait"]] }, 1, 0] } },
          callbacksCalling: { $sum: { $cond: [{ $eq: ["$callbackStatus", "calling"] }, 1, 0] } },
          callbacksCompleted: { $sum: { $cond: [{ $eq: ["$callbackStatus", "completed"] }, 1, 0] } },
          callbacksNeedAttention: { $sum: { $cond: [{ $eq: ["$callbackStatus", "needs_attention"] }, 1, 0] } },
          conversionsVerified: { $sum: { $cond: [{ $eq: ["$conversionStatus", "verified"] }, 1, 0] } },
          crmSynced: { $sum: { $cond: [{ $eq: ["$crmSyncStatus", "synced"] }, 1, 0] } },
          crmFailed: { $sum: { $cond: [{ $eq: ["$crmSyncStatus", "failed"] }, 1, 0] } },
        },
      },
    ]),
    CallDetailRecordModel.aggregate<{
      _id: null;
      attempts: number;
      connected: number;
      voicemail: number;
      failed: number;
      totalCost: number;
    }>([
      { $match: { campaignId: campaign._id } },
      {
        $group: {
          _id: null,
          attempts: { $sum: 1 },
          connected: { $sum: { $cond: [{ $ne: ["$startedAt", null] }, 1, 0] } },
          voicemail: { $sum: { $cond: ["$voicemailDetected", 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          totalCost: { $sum: { $ifNull: ["$costBreakdown.customerCost", 0] } },
        },
      },
    ]),
    CallDetailRecordModel.aggregate<{ _id: null; attemptedContacts: number; connectedContacts: number }>([
      { $match: { campaignId: campaign._id, campaignLeadId: { $ne: null } } },
      {
        $group: {
          _id: "$campaignLeadId",
          connected: { $max: { $cond: [{ $ne: ["$startedAt", null] }, 1, 0] } },
        },
      },
      {
        $group: {
          _id: null,
          attemptedContacts: { $sum: 1 },
          connectedContacts: { $sum: "$connected" },
        },
      },
    ]),
    CampaignBusinessEventModel.aggregate<{
      _id: null;
      verifiedAppointments: number;
      verifiedPayments: number;
      attributedRevenue: number;
    }>([
      { $match: { campaignId: campaign._id, status: "verified" } },
      {
        $group: {
          _id: null,
          verifiedAppointments: { $sum: { $cond: [{ $in: ["$type", ["appointment", "booking"]] }, 1, 0] } },
          verifiedPayments: { $sum: { $cond: [{ $in: ["$type", ["payment", "revenue"]] }, 1, 0] } },
          attributedRevenue: { $sum: { $cond: [{ $in: ["$type", ["payment", "revenue"]] }, "$amount", 0] } },
        },
      },
    ]),
    CampaignBusinessEventModel.aggregate<{ _id: string; amount: number }>([
      { $match: { campaignId: campaign._id, status: "verified", type: { $in: ["payment", "revenue"] }, amount: { $gt: 0 } } },
      { $group: { _id: { $ifNull: ["$currency", "USD"] }, amount: { $sum: "$amount" } } },
      { $sort: { _id: 1 } },
    ]),
    CallDetailRecordModel.aggregate<{ _id: string; attempts: number; connected: number; cost: number }>([
      { $match: { campaignId: campaign._id } },
      {
        $group: {
          _id: { $dateToString: { date: { $ifNull: ["$startedAt", "$createdAt"] }, format: "%Y-%m-%d", timezone: campaign.timezone } },
          attempts: { $sum: 1 },
          connected: { $sum: { $cond: [{ $ne: ["$startedAt", null] }, 1, 0] } },
          cost: { $sum: { $ifNull: ["$costBreakdown.customerCost", 0] } },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: 90 },
    ]),
    CampaignLeadModel.aggregate<{ _id: string; goals: number; classified: number }>([
      { $match: { campaignId: campaign._id, outcomeUpdatedAt: { $ne: null } } },
      {
        $group: {
          _id: { $dateToString: { date: "$outcomeUpdatedAt", format: "%Y-%m-%d", timezone: campaign.timezone } },
          goals: { $sum: { $cond: [{ $in: ["$outcome", ["qualified", "resolved"]] }, 1, 0] } },
          classified: { $sum: { $cond: [{ $ne: ["$outcome", "unknown"] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: 90 },
    ]),
  ]);
  const leads = leadGroups[0] ?? {
    total: campaign.totalLeads,
    classified: 0,
    qualified: 0,
    followUp: 0,
    resolved: 0,
    missed: 0,
    notInterested: 0,
    callbacksScheduled: 0,
    callbacksCalling: 0,
    callbacksCompleted: 0,
    callbacksNeedAttention: 0,
    conversionsVerified: 0,
    crmSynced: 0,
    crmFailed: 0,
  };
  const calls = callGroups[0] ?? {
    attempts: 0,
    connected: 0,
    voicemail: 0,
    failed: 0,
    totalCost: 0,
  };
  const contactCalls = contactCallGroups[0] ?? { attemptedContacts: 0, connectedContacts: 0 };
  const events = eventGroups[0] ?? { verifiedAppointments: 0, verifiedPayments: 0, attributedRevenue: 0 };
  const goalOutcomes = leads.qualified + leads.resolved;
  const followUpHandled = Math.max(0, leads.total - leads.followUp + leads.callbacksScheduled + leads.callbacksCalling + leads.callbacksCompleted);
  const averageQaScore = !weights.enabled || !leads.total ? 0 : Math.round(
    (contactCalls.connectedContacts / leads.total) * weights.connectionWeight +
    (leads.classified / leads.total) * weights.outcomeWeight +
    (Math.min(leads.total, goalOutcomes + leads.conversionsVerified) / leads.total) * weights.goalWeight +
    (Math.min(leads.total, followUpHandled) / leads.total) * weights.followUpWeight,
  );
  const outcomeByDay = new Map(outcomeTimeline.map((item) => [item._id, item]));
  const timeline = callTimeline.map((item) => ({
    date: item._id,
    attempts: item.attempts,
    connected: item.connected,
    goals: outcomeByDay.get(item._id)?.goals ?? 0,
    classified: outcomeByDay.get(item._id)?.classified ?? 0,
    cost: Math.round(item.cost * 1_000_000) / 1_000_000,
  }));
  response.json({
    campaign: {
      _id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      timezone: campaign.timezone,
      scorecard: weights,
    },
    summary: {
      contacts: leads.total,
      attempts: calls.attempts,
      connected: calls.connected,
      voicemail: calls.voicemail,
      failed: calls.failed,
      qualified: leads.qualified,
      followUp: leads.followUp,
      resolved: leads.resolved,
      missed: leads.missed,
      notInterested: leads.notInterested,
      unknown: Math.max(0, leads.total - leads.classified),
      callbacksScheduled: leads.callbacksScheduled,
      callbacksCalling: leads.callbacksCalling,
      callbacksCompleted: leads.callbacksCompleted,
      callbacksNeedAttention: leads.callbacksNeedAttention,
      attemptedContacts: contactCalls.attemptedContacts,
      connectedContacts: contactCalls.connectedContacts,
      verifiedAppointments: events.verifiedAppointments,
      verifiedPayments: events.verifiedPayments,
      attributedRevenue: Math.round(events.attributedRevenue * 100) / 100,
      revenueByCurrency: revenueGroups.map((item) => ({
        currency: item._id,
        amount: Math.round(item.amount * 100) / 100,
      })),
      conversionsVerified: leads.conversionsVerified,
      crmSynced: leads.crmSynced,
      crmFailed: leads.crmFailed,
      averageQaScore,
      pickupRate: calls.attempts ? Math.round((calls.connected / calls.attempts) * 1000) / 10 : 0,
      goalRate: leads.total ? Math.round((goalOutcomes / leads.total) * 1000) / 10 : 0,
      analysisCoverage: leads.total ? Math.round((leads.classified / leads.total) * 1000) / 10 : 0,
      totalCost: Math.round(calls.totalCost * 1_000_000) / 1_000_000,
      costPerGoal: goalOutcomes ? Math.round((calls.totalCost / goalOutcomes) * 1_000_000) / 1_000_000 : null,
      currency: "USD",
      updatedAt: new Date().toISOString(),
    },
    funnel: {
      contacts: leads.total,
      attempted: contactCalls.attemptedContacts,
      connected: contactCalls.connectedContacts,
      classified: leads.classified,
      goals: goalOutcomes,
      verifiedConversions: leads.conversionsVerified,
    },
    timeline,
  });
}

export async function exportCampaignResultsCsv(request: AuthenticatedRequest, response: Response) {
  const campaign = await findCampaign(request);
  const query = campaignLeadQuery(campaign._id, request.query);
  response.status(200);
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader(
    "Content-Disposition",
    'attachment; filename="campaign-' + campaign.id + '-results.csv"',
  );
  response.write(
    [
      "row", "name", "phone", "email", "company", "delivery_status", "business_outcome",
      "evidence", "evidence_quote", "qa_score", "conversion_type", "conversion_status", "attributed_revenue",
      "revenue_currency", "crm_sync_status", "attempts", "callback_status", "callback_scheduled_for",
      "last_call_status", "last_call_duration_seconds", "last_call_end_reason",
    ].map(escapeCsv).join(",") + "\n",
  );
  const batchSize = 500;
  let lastRow = 0;
  while (true) {
    const batch = await CampaignLeadModel.find({ ...query, row: { $gt: lastRow } })
      .sort({ row: 1 })
      .limit(batchSize)
      .lean();
    if (!batch.length) break;
    const enriched = await enrichCampaignLeads(batch, scorecardWeights(campaign));
    for (const lead of enriched) {
      const result = lead as Record<string, unknown> & {
        attempts: number;
        latestCall: Record<string, unknown> | null;
      };
      const latest = result.latestCall;
      response.write(
        [
          result.row,
          result.name,
          result.phone,
          result.email,
          result.company,
          result.status,
          result.outcome,
          result.outcomeEvidence,
          result.outcomeEvidenceQuote,
          result.qaScore,
          result.conversionType,
          result.conversionStatus,
          result.attributedRevenue,
          result.revenueCurrency,
          result.crmSyncStatus,
          result.attempts,
          result.callbackStatus,
          result.callbackScheduledFor instanceof Date ? result.callbackScheduledFor.toISOString() : result.callbackScheduledFor,
          latest?.status ?? "",
          latest?.durationSeconds ?? 0,
          latest?.endReason ?? latest?.errorMessage ?? "",
        ].map(escapeCsv).join(",") + "\n",
      );
    }
    lastRow = Number(batch[batch.length - 1]?.row ?? lastRow);
    if (batch.length < batchSize) break;
  }
  response.end();
}

export async function pauseCampaign(request: AuthenticatedRequest, response: Response) {
  const campaign = await findCampaign(request);
  if (!new Set(["running", "scheduled"]).has(campaign.status)) throw new HttpError(409, "Only running or scheduled campaigns can be paused.");
  const paused = await CampaignModel.findOneAndUpdate(
    { _id: campaign._id, ownerId: campaign.ownerId, status: { $in: ["running", "scheduled"] } },
    { $set: { status: "paused", leaseToken: "", leasedUntil: null } },
    { new: true },
  );
  if (!paused) throw new HttpError(409, "The campaign changed before it could be paused. Refresh and retry.");
  const counts = await campaignCounts([paused._id]);
  response.json({ campaign: serializeCampaign(paused, counts.get(paused.id)) });
}

export async function resumeCampaign(request: AuthenticatedRequest, response: Response) {
  const campaign = await findCampaign(request);
  if (campaign.status !== "paused") throw new HttpError(409, "Only paused campaigns can be resumed.");
  const now = new Date();
  const nextStatus = campaign.scheduledAt && campaign.scheduledAt > now ? "scheduled" : "running";
  const resumed = await CampaignModel.findOneAndUpdate(
    { _id: campaign._id, ownerId: campaign.ownerId, status: "paused", cancellationRequestedAt: null },
    {
      $set: {
        status: nextStatus,
        ...(nextStatus === "running" && !campaign.startedAt ? { startedAt: now } : {}),
      },
    },
    { new: true },
  );
  if (!resumed) throw new HttpError(409, "The campaign changed before it could be resumed. Refresh and retry.");
  const counts = await campaignCounts([resumed._id]);
  response.json({ campaign: serializeCampaign(resumed, counts.get(resumed.id)) });
}

export async function cancelCampaign(request: AuthenticatedRequest, response: Response) {
  const campaign = await findCampaign(request);
  if (campaign.status === "completed") {
    response.json({ campaign: serializeCampaign(campaign) });
    return;
  }

  let cancelledAt = new Date();
  if (campaign.status !== "cancelled") {
    const gateSession = await startSession();
    let gated = false;
    try {
      await gateSession.withTransaction(async () => {
        gated = false;
        const gatedCampaign = await CampaignModel.findOneAndUpdate(
          {
            _id: campaign._id,
            ownerId: campaign.ownerId,
            status: { $nin: ["completed", "cancelled"] },
            cancellationRequestedAt: null,
          },
          {
            $set: {
              // Paused is the durable no-new-dials gate while already-admitted
              // SIP setups drain. The final state is committed below.
              status: "paused",
              cancellationRequestedAt: cancelledAt,
            },
          },
          { new: true, session: gateSession },
        ).select("+cancellationRequestedAt");
        if (!gatedCampaign) return;
        gated = true;
        await CampaignLeadModel.updateMany(
          { campaignId: campaign._id, status: { $in: ["queued", "leased", "active", "retry_wait"] } },
          { $set: { status: "cancelled", leaseToken: "", leasedUntil: null } },
          { session: gateSession },
        );
        await AgentCampaignSlotModel.deleteMany(
          { campaignId: campaign._id },
          { session: gateSession },
        );
      });
    } finally {
      await gateSession.endSession();
    }
    if (!gated) {
      const winner = await CampaignModel.findOne({
        _id: campaign._id,
        ownerId: campaign.ownerId,
      }).select("+cancellationRequestedAt");
      if (!winner) throw new HttpError(404, "Campaign not found.");
      if (winner.status === "completed") {
        const counts = await campaignCounts([winner._id]);
        response.json({ campaign: serializeCampaign(winner, counts.get(winner.id)) });
        return;
      }
      const cancellationInProgress = winner.status === "paused" && Boolean(winner.cancellationRequestedAt);
      if (winner.status !== "cancelled" && !cancellationInProgress) {
        throw new HttpError(409, "The campaign changed before cancellation could start. Refresh and retry.");
      }
      cancelledAt = winner.cancellationRequestedAt ?? winner.completedAt ?? cancelledAt;
    }
  }

  const sweepCalls = async () => {
    const calls = await CallDetailRecordModel.find({
      campaignId: campaign._id,
      $or: [
        { status: { $in: ["initiated", "ringing", "active"] } },
        { status: "cancelled" },
      ],
    }).select("livekitRoomName status outboundSetupPending");
    const failures: string[] = [];
    const transitionResults = await Promise.allSettled(
      calls
        .filter((call) => ["initiated", "ringing", "active"].includes(call.status))
        .map((call) => transitionCallToCancelled(
          call.livekitRoomName,
          "Campaign cancelled by user.",
          { deferFinalizationUntilRoomClosed: true },
        )),
    );
    for (const result of transitionResults) {
      if (result.status === "rejected") {
        failures.push(`cdr-transition:${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }

    const roomNames = [...new Set(calls.map((call) => call.livekitRoomName).filter(Boolean))];
    let failedRooms = new Set<string>();
    try {
      failedRooms = new Set(await endCallRooms(roomNames));
      failures.push(...[...failedRooms].map((roomName) => `room:${roomName}`));
    } catch (error) {
      failedRooms = new Set(roomNames);
      failures.push(`room-cleanup:${error instanceof Error ? error.message : String(error)}`);
    }

    // Room deletion is requested before final effects so the worker has the
    // best chance to flush its last transcript/usage event. A room_finished
    // race cannot overwrite cancelled because every terminal transition is a
    // compare-and-set on the open statuses.
    const finalizationResults = await Promise.allSettled(
      calls
        .filter((call) => !failedRooms.has(call.livekitRoomName) && !call.outboundSetupPending)
        .map(async (call) => {
          await releaseTerminalFinalizationDeferral(call.livekitRoomName);
        }),
    );
    for (const result of finalizationResults) {
      if (result.status === "rejected") {
        failures.push(`cdr-finalization:${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
    return [...new Set(failures)];
  };

  // An admission is held until outbound SIP setup returns. Blocking new work,
  // sweeping now, and waiting for exact rows to disappear closes the gap where
  // cancellation could otherwise delete a room just before it was created.
  const setupStillPending = async () => {
    const now = new Date();
    const [activeAdmission, durableSetup] = await Promise.all([
      PhoneNumberCallAdmissionModel.exists({
        campaignId: campaign._id,
        expiresAt: { $gt: now },
      }),
      CallDetailRecordModel.exists({
        campaignId: campaign._id,
        outboundSetupPending: true,
      }),
    ]);
    return Boolean(activeAdmission || durableSetup);
  };
  const drainDeadline = Date.now() + 40_000;
  let pendingSetup = await setupStillPending();
  while (pendingSetup && Date.now() < drainDeadline) {
    await sweepCalls();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    pendingSetup = await setupStillPending();
  }
  if (pendingSetup) {
    throw new HttpError(
      503,
      "Campaign cancellation is safely blocked by an in-progress call setup. Retry after it finishes or run the documented setup recovery procedure if its process was drained.",
    );
  }

  const finalSession = await startSession();
  const finalOutcome: { state: "cancelled" | "completed" | "conflict" } = { state: "conflict" };
  try {
    await finalSession.withTransaction(async () => {
      finalOutcome.state = "conflict";
      const transitioned = await CampaignModel.findOneAndUpdate(
        {
          _id: campaign._id,
          ownerId: campaign.ownerId,
          status: "paused",
          cancellationRequestedAt: { $ne: null },
        },
        {
          $set: {
            status: "cancelled",
            completedAt: cancelledAt,
            leaseToken: "",
            leasedUntil: null,
            cancellationRequestedAt: null,
          },
        },
        { new: true, session: finalSession },
      );
      const cancelledCampaign = transitioned ?? await CampaignModel.findOne({
        _id: campaign._id,
        ownerId: campaign.ownerId,
        status: "cancelled",
      }).session(finalSession);
      if (!cancelledCampaign) {
        const naturallyCompleted = await CampaignModel.exists({
          _id: campaign._id,
          ownerId: campaign.ownerId,
          status: "completed",
        }).session(finalSession);
        finalOutcome.state = naturallyCompleted ? "completed" : "conflict";
        return;
      }
      finalOutcome.state = "cancelled";
      await CampaignLeadModel.updateMany(
        { campaignId: campaign._id, status: { $in: ["queued", "leased", "active", "retry_wait"] } },
        { $set: { status: "cancelled", leaseToken: "", leasedUntil: null } },
        { session: finalSession },
      );
      await CampaignLeadModel.updateMany(
        {
          campaignId: campaign._id,
          callbackStatus: { $in: ["scheduled", "calling", "retry_wait", "needs_attention"] },
        },
        { $set: { callbackStatus: "cancelled" } },
        { session: finalSession },
      );
      await AgentCampaignSlotModel.deleteMany(
        { campaignId: campaign._id },
        { session: finalSession },
      );
      await ScheduledCallbackModel.updateMany(
        {
          campaignId: campaign._id,
          ownerId: campaign.ownerId,
          status: { $in: ["scheduled", "leased", "calling", "retry_wait", "needs_attention"] },
        },
        {
          $set: {
            status: "cancelled",
            lastError: "Campaign cancelled by user.",
            leaseToken: "",
            leasedUntil: null,
          },
        },
        { session: finalSession },
      );
    });
  } finally {
    await finalSession.endSession();
  }
  if (finalOutcome.state !== "cancelled") {
    const winner = await CampaignModel.findOne({
      _id: campaign._id,
      ownerId: campaign.ownerId,
    });
    if (!winner) throw new HttpError(404, "Campaign not found.");
    if (winner.status === "completed") {
      const counts = await campaignCounts([winner._id]);
      response.json({ campaign: serializeCampaign(winner, counts.get(winner.id)) });
      return;
    }
    throw new HttpError(409, "The campaign changed before cancellation could finish. Refresh and retry.");
  }

  const cleanupFailures = await sweepCalls();
  const persistedCampaign = await CampaignModel.findOne({
    _id: campaign._id,
    ownerId: campaign.ownerId,
  });
  if (!persistedCampaign) throw new HttpError(404, "Campaign not found.");
  if (cleanupFailures.length) {
    throw new HttpError(
      503,
      "Campaign is cancelled, but one or more call rooms still need cleanup. Retry cancellation.",
    );
  }
  const counts = await campaignCounts([campaign._id]);
  response.json({ campaign: serializeCampaign(persistedCampaign, counts.get(persistedCampaign.id)) });
}

export async function listSuppressions(request: AuthenticatedRequest, response: Response) {
  const suppressions = await ContactSuppressionModel.find({ ownerId: ownerId(request) }).sort({ createdAt: -1 }).limit(500);
  response.json({ suppressions });
}

export async function createSuppression(request: AuthenticatedRequest, response: Response) {
  const orgId = ownerId(request);
  const phone = normalizeE164(cleanText(request.body?.phone, 40));
  if (!phone) throw new HttpError(400, "Phone number must include an international country code.");
  const suppression = await ContactSuppressionModel.findOneAndUpdate(
    { ownerId: orgId, phone },
    {
      $set: {
        reason: cleanText(request.body?.reason, 500) || "Opted out",
        source: cleanText(request.body?.source, 120) || "manual",
        createdBy: request.user!.id,
      },
    },
    { new: true, upsert: true, runValidators: true },
  );
  response.status(201).json({ suppression });
}

export async function deleteSuppression(request: AuthenticatedRequest, response: Response) {
  if (!isValidObjectId(request.params.suppressionId)) throw new HttpError(400, "Valid suppressionId is required.");
  const deleted = await ContactSuppressionModel.findOneAndDelete({ _id: request.params.suppressionId, ownerId: ownerId(request) });
  if (!deleted) throw new HttpError(404, "Suppression not found.");
  response.status(204).end();
}
