import { randomUUID } from "node:crypto";
import { startSession } from "mongoose";

import { AgentCampaignSlotModel } from "../models/AgentCampaignSlot.js";
import { CampaignLeadModel } from "../models/CampaignLead.js";
import { CampaignModel, type CampaignDocument } from "../models/Campaign.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { ContactSuppressionModel } from "../models/ContactSuppression.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { VoiceAgentModel, type VoiceAgentDocument } from "../models/VoiceAgent.js";
import { assertCallCapacity } from "./billingService.js";
import {
  releaseTerminalFinalizationDeferral,
  transitionCallToCancelled,
} from "./callRecordService.js";
import {
  endCallRooms,
  reconcileOpenCallRecordsForAgent,
  startOutboundCall,
} from "./livekitService.js";
import { acquirePhoneNumberCallAdmission } from "./phoneNumberCallAdmissionService.js";

const outboundSetupRepairReminderMs = 10 * 60 * 1_000;

const terminalLeadStatuses = ["completed", "failed", "suppressed", "cancelled"];
const openCallStatuses = ["initiated", "ringing", "active"];
const campaignLeaseMs = 120_000;
let workerRunning = false;

function messageFrom(error: unknown) {
  if (error instanceof Error) return error.message.slice(0, 2000);
  return String(error).slice(0, 2000);
}

function safeTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "UTC";
  }
}

export function campaignLocalClock(timezone: string, at = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(at).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday: String(parts.weekday ?? "").toLowerCase().slice(0, 3),
  };
}

export function isInsideCallWindow(start: string, end: string, time: string) {
  if (start === end) return true;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

function agentInsideBusinessHours(agent: VoiceAgentDocument, now: Date) {
  if (!agent.businessHoursEnabled || !agent.businessHours?.schedule?.length) return true;
  const local = campaignLocalClock(agent.businessHours.timezone, now);
  const schedule = agent.businessHours.schedule.find((item) => item.day === local.weekday);
  return Boolean(schedule?.enabled && isInsideCallWindow(schedule.start, schedule.end, local.time));
}

function customMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(key))
      .map(([key, item]) => [key, typeof item === "string" ? item.slice(0, 500) : item])
      .slice(0, 40),
  );
}

function callIndicatesOptOut(call: { tags?: string[]; endReason?: string; structuredOutput?: unknown }) {
  if ((call.tags ?? []).some((tag) => /opt.?out|do.?not.?call|unsubscribe/i.test(tag))) return true;
  if (/opt.?out|do.?not.?call|unsubscribe/i.test(call.endReason ?? "")) return true;
  if (!call.structuredOutput || typeof call.structuredOutput !== "object") return false;
  return Object.entries(call.structuredOutput as Record<string, unknown>).some(([key, value]) =>
    /opt.?out|do.?not.?call|unsubscribe/i.test(key)
      && (value === true || ["true", "yes", "opted_out"].includes(String(value).toLowerCase())),
  );
}

async function markLeadFailure(
  campaign: CampaignDocument,
  lead: { _id: unknown; attemptCount: number; leaseToken?: string; callId?: unknown },
  error: string,
) {
  const retry = lead.attemptCount < campaign.maxAttempts;
  const currentAttempt = lead.leaseToken
    ? { status: "leased", leaseToken: lead.leaseToken }
    : lead.callId
      ? { status: "active", callId: lead.callId }
      : null;
  if (!currentAttempt) return;
  const transition = await CampaignLeadModel.updateOne(
    { _id: lead._id, ...currentAttempt },
    {
      $set: {
        status: retry ? "retry_wait" : "failed",
        nextAttemptAt: retry ? new Date(Date.now() + campaign.retryGapSeconds * 1000) : null,
        lastError: error,
        leaseToken: "",
        leasedUntil: null,
      },
    },
  );
  if (transition.matchedCount === 1) {
    await AgentCampaignSlotModel.deleteOne({ campaignLeadId: lead._id });
  }
}

async function acquireAgentSlot(
  campaign: CampaignDocument,
  leadId: unknown,
  maximumSlots: number,
  leaseToken: string,
) {
  const leasedUntil = new Date(Date.now() + 4 * 60 * 60 * 1000);
  for (let slot = 0; slot < maximumSlots; slot += 1) {
    try {
      const reservation = await AgentCampaignSlotModel.findOneAndUpdate(
        {
          agentId: campaign.agentId,
          slot,
          $or: [{ leasedUntil: { $lte: new Date() } }, { campaignLeadId: leadId }],
        },
        {
          $set: {
            ownerId: campaign.ownerId,
            agentId: campaign.agentId,
            slot,
            campaignId: campaign._id,
            campaignLeadId: leadId,
            leaseToken,
            leasedUntil,
          },
        },
        { new: true, upsert: true, runValidators: true },
      );
      if (reservation) return true;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
    }
  }
  return false;
}

async function cleanExpiredAgentSlots() {
  await AgentCampaignSlotModel.deleteMany({ leasedUntil: { $lte: new Date() } });
  const slots = await AgentCampaignSlotModel.find().sort({ updatedAt: 1 }).limit(1000).select("campaignLeadId");
  if (!slots.length) return;
  const leads = await CampaignLeadModel.find({ _id: { $in: slots.map((slot) => slot.campaignLeadId) } }).select("_id status");
  const openLeadIds = new Set(leads.filter((lead) => ["leased", "active"].includes(lead.status)).map((lead) => lead.id));
  const staleLeadIds = slots.filter((slot) => !openLeadIds.has(String(slot.campaignLeadId))).map((slot) => slot.campaignLeadId);
  if (staleLeadIds.length) await AgentCampaignSlotModel.deleteMany({ campaignLeadId: { $in: staleLeadIds } });
}

async function reconcileCampaignLeads(campaign: CampaignDocument) {
  const leads = await CampaignLeadModel.find({
    campaignId: campaign._id,
    status: { $in: ["leased", "active"] },
  }).select("_id status callId attemptCount +leaseToken +leasedUntil updatedAt");
  if (!leads.length) return;

  const callIds = leads.map((lead) => lead.callId).filter(Boolean);
  const calls = await CallDetailRecordModel.find({
    campaignId: campaign._id,
    $or: [
      ...(callIds.length ? [{ _id: { $in: callIds } }] : []),
      { campaignLeadId: { $in: leads.map((lead) => lead._id) } },
    ],
  })
    .select("_id campaignLeadId status errorMessage endReason tags structuredOutput updatedAt createdAt outboundSetupPending outboundSetupStage")
    .sort({ createdAt: -1 });
  const callsById = new Map(calls.map((call) => [call.id, call]));
  const callsByLeadId = new Map<string, (typeof calls)[number]>();
  for (const call of calls) {
    const leadId = String(call.campaignLeadId ?? "");
    if (leadId && !callsByLeadId.has(leadId)) callsByLeadId.set(leadId, call);
  }
  const now = new Date();

  for (const lead of leads) {
    const call = (lead.callId ? callsById.get(String(lead.callId)) : undefined)
      ?? callsByLeadId.get(lead.id);
    if (call?.outboundSetupPending) {
      // A DB-only ringing CDR is still setup, not an active call. Preserve its
      // slot and lease without promoting the lead until the exact setup owner
      // establishes SIP or an operator drains the old process and runs exact
      // verified recovery. Age alone cannot distinguish a crash from pause.
      await Promise.all([
        AgentCampaignSlotModel.updateOne(
          { campaignLeadId: lead._id },
          { $set: { leasedUntil: new Date(Date.now() + outboundSetupRepairReminderMs) } },
        ),
        CampaignLeadModel.updateOne(
          { _id: lead._id, status: "leased", leaseToken: lead.leaseToken },
          {
            $set: {
              callId: call._id,
              leasedUntil: new Date(Date.now() + outboundSetupRepairReminderMs),
            },
          },
        ),
      ]);
      continue;
    }
    if (call && !lead.callId && lead.status === "leased") {
      const linked = await CampaignLeadModel.updateOne(
        { _id: lead._id, status: "leased", leaseToken: lead.leaseToken, callId: null },
        { $set: { callId: call._id } },
      );
      if (linked.matchedCount === 1) lead.callId = call._id;
    }
    if (call?.status === "completed") {
      if (callIndicatesOptOut(call)) {
        const leadRecord = await CampaignLeadModel.findById(lead._id).select("phone");
        if (leadRecord) {
          await ContactSuppressionModel.findOneAndUpdate(
            { ownerId: campaign.ownerId, phone: leadRecord.phone },
            { $set: { reason: "Opt-out captured during campaign call.", source: "campaign", createdBy: "system" } },
            { upsert: true, new: true, runValidators: true },
          );
        }
      }
      const completed = await CampaignLeadModel.updateOne(
        {
          _id: lead._id,
          status: lead.status,
          callId: lead.callId,
          ...(lead.status === "leased" ? { leaseToken: lead.leaseToken } : {}),
        },
        { $set: { status: "completed", lastError: "", nextAttemptAt: null, leaseToken: "", leasedUntil: null } },
      );
      if (completed.matchedCount === 1) {
        await AgentCampaignSlotModel.deleteOne({ campaignLeadId: lead._id });
      }
      continue;
    }
    if (call?.status === "failed" || call?.status === "cancelled") {
      await markLeadFailure(campaign, lead, call.errorMessage || call.endReason || `Call ${call.status}.`);
      continue;
    }
    if (call && openCallStatuses.includes(call.status) && Date.now() - call.updatedAt.getTime() > 3 * 60 * 60 * 1000) {
      await markLeadFailure(campaign, lead, "Call remained open beyond the maximum recovery window.");
      continue;
    }
    if (call && openCallStatuses.includes(call.status)) {
      await AgentCampaignSlotModel.updateOne(
        { campaignLeadId: lead._id },
        { $set: { leasedUntil: new Date(Date.now() + 4 * 60 * 60 * 1000) } },
      );
      if (lead.status !== "active") {
        await CampaignLeadModel.updateOne(
          { _id: lead._id, status: "leased", leaseToken: lead.leaseToken, callId: lead.callId },
          { $set: { status: "active", leaseToken: "", leasedUntil: null } },
        );
      }
      continue;
    }
    if (!call && lead.leasedUntil && lead.leasedUntil <= now) {
      await markLeadFailure(campaign, lead, "Campaign worker lease expired before the call was created.");
    }
  }
}

async function dialLead(
  campaign: CampaignDocument,
  agent: VoiceAgentDocument,
  phone: { _id: unknown; number: string },
  leadId: string,
  leaseToken: string,
) {
  const lead = await CampaignLeadModel.findOne({
    _id: leadId,
    campaignId: campaign._id,
    status: "leased",
    leaseToken,
  }).select("+leaseToken");
  if (!lead) return;
  try {
    if (campaign.respectDnc && await ContactSuppressionModel.exists({ ownerId: campaign.ownerId, phone: lead.phone })) {
      const suppressed = await CampaignLeadModel.updateOne(
        { _id: lead._id, status: "leased", leaseToken },
        { $set: { status: "suppressed", suppressionReason: "Contact is on the organization suppression list.", leaseToken: "", leasedUntil: null } },
      );
      if (suppressed.matchedCount === 1) {
        await AgentCampaignSlotModel.deleteOne({ campaignLeadId: lead._id });
      }
      return;
    }
    await assertCallCapacity(campaign.ownerId);
    const metadata = {
      ...customMetadata(lead.customFields),
      CampaignId: campaign.id,
      CampaignName: campaign.name,
      CampaignGoal: campaign.goal,
      SuccessCriteria: campaign.successCriteria,
      ConsentOpeningRequired: campaign.requireConsentLine,
      DetectVoicemail: campaign.detectVoicemail,
      LeadRow: lead.row,
      LeadPhone: lead.phone,
      LeadName: lead.name,
      LeadEmail: lead.email,
      LeadCompany: lead.company,
    };
    const call = await (async () => {
      const callAdmission = await acquirePhoneNumberCallAdmission(
        campaign.ownerId,
        String(phone._id),
        { campaignId: campaign.id },
      );
      try {
        const lockedNumber = callAdmission.phone;
        if (
          String(lockedNumber.agentId ?? "") !== String(agent._id)
          || lockedNumber.status !== "Ready"
          || !["Outbound", "Both"].includes(lockedNumber.direction)
        ) {
          throw new Error("The campaign caller ID changed or is no longer ready.");
        }
        return await startOutboundCall(agent, campaign.ownerId, lead.phone, lockedNumber.number, {
          phoneNumberId: lockedNumber.id,
          callAdmission,
          campaignId: campaign.id,
          campaignLeadId: lead.id,
          metadata,
          onCallCreated: async (callId) => {
            const [leadClaim, campaignClaim] = await Promise.all([
              CampaignLeadModel.updateOne(
                { _id: lead._id, campaignId: campaign._id, status: "leased", leaseToken },
                { $set: { callId } },
              ),
              CampaignModel.exists({
                _id: campaign._id,
                status: "running",
                leaseToken,
              }),
            ]);
            if (leadClaim.matchedCount !== 1 || !campaignClaim) {
              throw new Error("Campaign stopped before the call could be placed.");
            }
          },
        });
      } finally {
        await callAdmission.release().catch((error) => {
          console.error(JSON.stringify({
            event: "campaign-phone-admission-release-failed",
            phoneNumberId: String(phone._id),
            campaignId: campaign.id,
            error: messageFrom(error),
          }));
        });
      }
    })();
    const activated = await CampaignLeadModel.updateOne(
      { _id: lead._id, status: "leased", leaseToken },
      {
        $set: {
          status: "active",
          callId: call.callId,
          lastError: "",
          leaseToken: "",
          leasedUntil: null,
        },
      },
    );
    if (activated.matchedCount !== 1) {
      await transitionCallToCancelled(
        call.roomName,
        "Campaign stopped during call setup.",
        { deferFinalizationUntilRoomClosed: true },
      );
      const roomFailures = await endCallRooms([call.roomName]);
      if (roomFailures.length) {
        throw new Error("Campaign call was cancelled, but its LiveKit room still needs cleanup.");
      }
      await releaseTerminalFinalizationDeferral(call.roomName);
    }
  } catch (error) {
    await markLeadFailure(campaign, lead, messageFrom(error));
  }
}

async function finishCampaignIfDone(campaign: CampaignDocument) {
  const remaining = await CampaignLeadModel.exists({
    campaignId: campaign._id,
    status: { $nin: terminalLeadStatuses },
  });
  if (!remaining) {
    await CampaignModel.updateOne(
      { _id: campaign._id, status: "running" },
      { $set: { status: "completed", completedAt: new Date(), leaseToken: "", leasedUntil: null } },
    );
    return true;
  }
  return false;
}

async function processCampaign(campaign: CampaignDocument, leaseToken: string) {
  const now = new Date();
  const freshCampaign = await CampaignModel.findOne({ _id: campaign._id, status: "running" }).select("+leaseToken +leasedUntil");
  if (!freshCampaign || freshCampaign.leaseToken !== leaseToken) return;
  const agent = await VoiceAgentModel.findOne({
    _id: freshCampaign.agentId,
    ownerId: freshCampaign.ownerId,
  });
  // Campaign calls bypass the interactive admission path that already runs
  // stale LiveKit recovery. Recover first, then map terminal calls back to
  // leads in this same cycle so their concurrency slots are released.
  if (agent) await reconcileOpenCallRecordsForAgent(agent);
  await reconcileCampaignLeads(freshCampaign);
  if (await finishCampaignIfDone(freshCampaign)) return;

  const stillOwned = await CampaignModel.exists({
    _id: freshCampaign._id,
    status: "running",
    leaseToken,
  });
  if (!stillOwned) return;
  const local = campaignLocalClock(freshCampaign.timezone, now);
  if (!isInsideCallWindow(freshCampaign.windowStart, freshCampaign.windowEnd, local.time)) return;

  if (freshCampaign.dailyAttemptDate !== local.date) {
    const reset = await CampaignModel.updateOne(
      { _id: freshCampaign._id, status: "running", leaseToken },
      { $set: { dailyAttemptDate: local.date, dailyAttemptCount: 0 } },
    );
    if (reset.matchedCount !== 1) return;
    freshCampaign.dailyAttemptDate = local.date;
    freshCampaign.dailyAttemptCount = 0;
  }
  const dailyRemaining = Math.max(0, freshCampaign.dailyLimit - freshCampaign.dailyAttemptCount);
  if (!dailyRemaining) return;

  const [phone, campaignOpen, externalAgentOpen] = await Promise.all([
    PhoneNumberModel.findOne({
      _id: freshCampaign.phoneNumberId,
      ownerId: freshCampaign.ownerId,
      agentId: freshCampaign.agentId,
      status: "Ready",
      direction: { $in: ["Outbound", "Both"] },
      lifecycle: { $ne: "deleting" },
    }),
    CampaignLeadModel.countDocuments({ campaignId: freshCampaign._id, status: { $in: ["leased", "active"] } }),
    CallDetailRecordModel.countDocuments({
      ownerId: freshCampaign.ownerId,
      agentId: freshCampaign.agentId,
      $or: [{ campaignId: null }, { campaignId: { $exists: false } }],
      status: { $in: openCallStatuses },
    }),
  ]);
  if (!agent || agent.status !== "Live") throw new Error("Campaign agent is not Live or no longer exists.");
  if (!phone) throw new Error("Campaign caller ID is no longer ready for outbound calls.");
  if (!agentInsideBusinessHours(agent, now)) return;

  const slots = Math.min(
    dailyRemaining,
    Math.max(0, freshCampaign.concurrency - campaignOpen),
    Math.max(0, agent.maxConcurrentCalls - externalAgentOpen),
  );
  if (!slots) return;

  const dueLeads = await CampaignLeadModel.find({
    campaignId: freshCampaign._id,
    status: { $in: ["queued", "retry_wait"] },
    $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
  }).sort({ row: 1 }).limit(slots).select("_id status");
  if (!dueLeads.length) return;

  const leadLeaseUntil = new Date(Date.now() + campaignLeaseMs);
  const leasedIds: string[] = [];
  for (const dueLead of dueLeads) {
    if (!await acquireAgentSlot(
      freshCampaign,
      dueLead._id,
      Math.max(0, agent.maxConcurrentCalls - externalAgentOpen),
      leaseToken,
    )) break;

    const leaseSession = await startSession();
    let leasedId = "";
    const leaseUnavailable = Symbol("campaign-lead-lease-unavailable");
    try {
      const transactionResult = await leaseSession.withTransaction(async () => {
        const ownership = await CampaignModel.updateOne(
          {
            _id: freshCampaign._id,
            status: "running",
            leaseToken,
            $expr: { $lt: ["$dailyAttemptCount", "$dailyLimit"] },
          },
          {
            $set: { leasedUntil: new Date(Date.now() + campaignLeaseMs) },
            $inc: { dailyAttemptCount: 1 },
          },
          { session: leaseSession },
        );
        if (ownership.matchedCount !== 1) throw leaseUnavailable;

        const leased = await CampaignLeadModel.findOneAndUpdate(
          { _id: dueLead._id, campaignId: freshCampaign._id, status: dueLead.status },
          {
            $set: {
              status: "leased",
              leaseToken,
              leasedUntil: leadLeaseUntil,
              lastAttemptAt: now,
              nextAttemptAt: null,
              callId: null,
            },
            $inc: { attemptCount: 1 },
          },
          { new: true, session: leaseSession },
        );
        if (!leased) throw leaseUnavailable;
        return leased.id;
      });
      leasedId = transactionResult ?? "";
    } catch (error) {
      if (error !== leaseUnavailable) throw error;
    } finally {
      await leaseSession.endSession();
    }
    if (leasedId) leasedIds.push(leasedId);
    else {
      await AgentCampaignSlotModel.deleteOne({ campaignLeadId: dueLead._id, leaseToken });
      const stillOwned = await CampaignModel.exists({
        _id: freshCampaign._id,
        status: "running",
        leaseToken,
      });
      if (!stillOwned) break;
    }
  }
  if (!leasedIds.length) return;
  await Promise.all(leasedIds.map((leadId) => dialLead(freshCampaign, agent, phone, leadId, leaseToken)));
  await finishCampaignIfDone(freshCampaign);
}

export async function processCampaignQueue() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const now = new Date();
    await cleanExpiredAgentSlots();
    await CampaignModel.updateMany(
      { status: "scheduled", scheduledAt: { $lte: now } },
      { $set: { status: "running", startedAt: now } },
    );
    const candidates = await CampaignModel.find({ status: "running" })
      .sort({ updatedAt: 1 })
      .limit(25)
      .select("_id");

    await Promise.all(candidates.map(async (candidate) => {
      const leaseToken = randomUUID();
      const campaign = await CampaignModel.findOneAndUpdate(
        {
          _id: candidate._id,
          status: "running",
          $or: [{ leasedUntil: null }, { leasedUntil: { $lte: now } }],
        },
        { $set: { leaseToken, leasedUntil: new Date(Date.now() + campaignLeaseMs) } },
        { new: true },
      ).select("+leaseToken +leasedUntil");
      if (!campaign) return;
      try {
        await processCampaign(campaign, leaseToken);
        await CampaignModel.updateOne(
          { _id: campaign._id, leaseToken },
          { $set: { leaseToken: "", leasedUntil: null, lastWorkerError: "" } },
        );
      } catch (error) {
        await CampaignModel.updateOne(
          { _id: campaign._id, leaseToken },
          { $set: { leaseToken: "", leasedUntil: null, lastWorkerError: messageFrom(error) } },
        );
      }
    }));
  } finally {
    workerRunning = false;
  }
}
