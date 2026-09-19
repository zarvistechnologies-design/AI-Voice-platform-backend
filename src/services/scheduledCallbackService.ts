import { randomUUID } from "node:crypto";

import { CampaignModel } from "../models/Campaign.js";
import { CampaignLeadModel } from "../models/CampaignLead.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { ContactSuppressionModel } from "../models/ContactSuppression.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { ScheduledCallbackModel } from "../models/ScheduledCallback.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { HttpError } from "../utils/httpError.js";
import { normalizeE164 } from "../utils/phoneNumber.js";
import { assertCallCapacity } from "./billingService.js";
import { campaignLocalClock, isInsideCallWindow } from "./campaignService.js";
import { startOutboundCall } from "./livekitService.js";
import { acquirePhoneNumberCallAdmission } from "./phoneNumberCallAdmissionService.js";

const dueLeaseMs = 4 * 60_000;
let callbackWorkerRunning = false;

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000);
}

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function nextAllowedCallbackTime(
  timezone: string,
  windowStart: string,
  windowEnd: string,
  after = new Date(),
) {
  const firstMinute = Math.ceil((after.getTime() + 1) / 60_000) * 60_000;
  for (let offset = 0; offset < 8 * 24 * 60; offset += 1) {
    const candidate = new Date(firstMinute + offset * 60_000);
    const local = campaignLocalClock(timezone, candidate);
    if (isInsideCallWindow(windowStart, windowEnd, local.time)) return candidate;
  }
  return new Date(after.getTime() + 24 * 60 * 60_000);
}

function callbackDestination(call: {
  direction: string;
  callerNumber?: string;
  calledNumber?: string;
}, requestedNumber = "") {
  return normalizeE164(
    requestedNumber || (call.direction === "outbound" ? call.calledNumber ?? "" : call.callerNumber ?? ""),
  );
}

export async function markCampaignCallbackForManualFollowUp(roomName: string) {
  const call = await CallDetailRecordModel.findOne({ livekitRoomName: roomName })
    .select("_id ownerId campaignId campaignLeadId")
    .lean();
  if (!call?.campaignId || !call.campaignLeadId) return;
  await CampaignLeadModel.updateOne(
    { _id: call.campaignLeadId, ownerId: call.ownerId },
    {
      $set: {
        callbackStatus: "needs_attention",
        callbackScheduledFor: null,
        outcome: "follow_up",
        outcomeEvidence: "system_confirmed",
        outcomeCallId: call._id,
        outcomeUpdatedAt: new Date(),
      },
    },
  );
}

export async function scheduleCampaignCallback(input: {
  roomName: string;
  callbackNumber?: string;
  callerName?: string;
  reason?: string;
  requestedText?: string;
  scheduledAt: string;
  timezone: string;
}) {
  const call = await CallDetailRecordModel.findOne({ livekitRoomName: input.roomName });
  if (!call) throw new HttpError(404, "The current call could not be found.");
  if (!call.campaignId || !call.campaignLeadId || !call.phoneNumberId) {
    throw new HttpError(409, "Automatic callbacks are available for campaign calls.");
  }

  const timezone = input.timezone.trim();
  if (!validTimezone(timezone)) throw new HttpError(400, "Use a valid IANA timezone for the callback.");
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.scheduledAt.trim())) {
    throw new HttpError(400, "The exact callback time must include its UTC offset.");
  }
  const scheduledFor = new Date(input.scheduledAt);
  const now = new Date();
  if (!Number.isFinite(scheduledFor.getTime())) {
    throw new HttpError(400, "Ask the caller for an exact callback date and time.");
  }
  if (scheduledFor.getTime() < now.getTime() + 60_000) {
    throw new HttpError(400, "The callback time must be at least one minute in the future.");
  }
  if (scheduledFor.getTime() > now.getTime() + 366 * 24 * 60 * 60_000) {
    throw new HttpError(400, "The callback cannot be scheduled more than one year ahead.");
  }

  const campaign = await CampaignModel.findOne({ _id: call.campaignId, ownerId: call.ownerId });
  if (!campaign || campaign.status === "cancelled") {
    throw new HttpError(409, "This campaign no longer accepts callbacks.");
  }
  if (campaign.automaticCallbacks === false) {
    throw new HttpError(409, "Automatic callbacks are disabled for this campaign.");
  }
  if (timezone !== campaign.timezone) {
    throw new HttpError(400, "Use the campaign timezone (" + campaign.timezone + ") for this callback.");
  }
  const local = campaignLocalClock(timezone, scheduledFor);
  if (!isInsideCallWindow(campaign.windowStart, campaign.windowEnd, local.time)) {
    throw new HttpError(
      409,
      "Choose a time inside the campaign calling window (" +
        campaign.windowStart + "-" + campaign.windowEnd + " " + timezone + ").",
    );
  }

  const destination = callbackDestination(call, input.callbackNumber);
  if (!destination) throw new HttpError(400, "A callback number with country code is required.");
  if (await ContactSuppressionModel.exists({ ownerId: call.ownerId, phone: destination })) {
    throw new HttpError(409, "This contact has opted out and cannot be scheduled for another call.");
  }

  const callback = await ScheduledCallbackModel.findOneAndUpdate(
    { sourceCallId: call._id },
    {
      $set: {
        ownerId: call.ownerId,
        campaignId: call.campaignId,
        campaignLeadId: call.campaignLeadId,
        agentId: call.agentId,
        phoneNumberId: call.phoneNumberId,
        destination,
        callerName: input.callerName?.trim().slice(0, 120) ?? "",
        reason: input.reason?.trim().slice(0, 500) ?? "",
        requestedText: input.requestedText?.trim().slice(0, 300) ?? "",
        timezone,
        scheduledFor,
        status: "scheduled",
        maxAttempts: Math.max(1, Math.min(10, campaign.maxAttempts || 2)),
        retryGapSeconds: Math.max(60, campaign.retryGapSeconds || 3600),
        callId: null,
        completedAt: null,
        lastError: "",
        leaseToken: "",
        leasedUntil: null,
      },
      $setOnInsert: { attemptCount: 0 },
    },
    { new: true, upsert: true, runValidators: true },
  );

  await CallDetailRecordModel.updateOne(
    { _id: call._id },
    {
      $set: {
        callbackRequested: true,
        "callbackDetails.callbackNumber": destination,
        "callbackDetails.preferredTime": input.requestedText?.trim().slice(0, 160) || scheduledFor.toISOString(),
        "callbackDetails.requestedAt": new Date(),
        "structuredOutput.callbackScheduledAt": scheduledFor,
        "structuredOutput.callbackTimezone": timezone,
        "structuredOutput.callbackStatus": "scheduled",
      },
      $addToSet: { tags: "callback_scheduled" },
    },
  );
  await CampaignLeadModel.updateOne(
    { _id: call.campaignLeadId, ownerId: call.ownerId },
    {
      $set: {
        callbackStatus: "scheduled",
        callbackScheduledFor: scheduledFor,
        outcome: "follow_up",
        outcomeEvidence: "system_confirmed",
        outcomeCallId: call._id,
        outcomeUpdatedAt: new Date(),
      },
    },
  );

  return callback;
}

async function reconcileCallingCallbacks() {
  const callbacks = await ScheduledCallbackModel.find({ status: "calling", callId: { $ne: null } })
    .sort({ updatedAt: 1 })
    .limit(100);
  if (!callbacks.length) return;
  const calls = await CallDetailRecordModel.find({ _id: { $in: callbacks.map((item) => item.callId) } })
    .select("_id status endReason errorMessage")
    .lean();
  const byId = new Map(calls.map((call) => [String(call._id), call]));
  for (const callback of callbacks) {
    const call = byId.get(String(callback.callId));
    if (!call || ["initiated", "ringing", "active"].includes(call.status)) continue;
    if (call.status === "completed") {
      const completed = await ScheduledCallbackModel.updateOne(
        { _id: callback._id, status: "calling", callId: callback.callId },
        { $set: { status: "completed", completedAt: new Date(), lastError: "" } },
      );
      if (completed.matchedCount === 1) {
        await CampaignLeadModel.updateOne(
          {
            _id: callback.campaignLeadId,
            ownerId: callback.ownerId,
            callbackScheduledFor: callback.scheduledFor,
          },
          { $set: { callbackStatus: "completed", callbackScheduledFor: callback.scheduledFor } },
        );
      }
      continue;
    }
    const retry = callback.attemptCount < callback.maxAttempts;
    const retryAt = retry
      ? new Date(Date.now() + callback.retryGapSeconds * 1000)
      : callback.scheduledFor;
    const transitioned = await ScheduledCallbackModel.updateOne(
      { _id: callback._id, status: "calling", callId: callback.callId },
      {
        $set: {
          status: retry ? "retry_wait" : "needs_attention",
          scheduledFor: retryAt,
          lastError: call.errorMessage || call.endReason || "Callback call " + call.status + ".",
        },
      },
    );
    if (transitioned.matchedCount === 1) {
      await CampaignLeadModel.updateOne(
        {
          _id: callback.campaignLeadId,
          ownerId: callback.ownerId,
          callbackScheduledFor: callback.scheduledFor,
        },
        {
          $set: {
            callbackStatus: retry ? "retry_wait" : "needs_attention",
            callbackScheduledFor: retryAt,
          },
        },
      );
    }
  }
}

async function processDueCallback(callbackId: string) {
  const leaseToken = randomUUID();
  const now = new Date();
  const callback = await ScheduledCallbackModel.findOneAndUpdate(
    {
      _id: callbackId,
      status: { $in: ["scheduled", "retry_wait", "leased"] },
      scheduledFor: { $lte: now },
      $or: [{ leasedUntil: null }, { leasedUntil: { $lte: now } }],
    },
    {
      $set: {
        status: "leased",
        leaseToken,
        leasedUntil: new Date(now.getTime() + dueLeaseMs),
      },
    },
    { new: true },
  ).select("+leaseToken +leasedUntil");
  if (!callback) return;

  try {
    const [campaign, agent, phone, suppressed] = await Promise.all([
      CampaignModel.findOne({ _id: callback.campaignId, ownerId: callback.ownerId }),
      VoiceAgentModel.findOne({ _id: callback.agentId, ownerId: callback.ownerId, status: "Live" }),
      PhoneNumberModel.findOne({ _id: callback.phoneNumberId, ownerId: callback.ownerId }),
      ContactSuppressionModel.exists({ ownerId: callback.ownerId, phone: callback.destination }),
    ]);
    if (!campaign || campaign.status === "cancelled") {
      await ScheduledCallbackModel.updateOne(
        { _id: callback._id, status: "leased", leaseToken },
        { $set: { status: "cancelled", lastError: "Campaign was cancelled.", leaseToken: "", leasedUntil: null } },
      );
      await CampaignLeadModel.updateOne(
        {
          _id: callback.campaignLeadId,
          ownerId: callback.ownerId,
          callbackScheduledFor: callback.scheduledFor,
        },
        { $set: { callbackStatus: "cancelled", callbackScheduledFor: callback.scheduledFor } },
      );
      return;
    }
    if (campaign.status === "paused") {
      await ScheduledCallbackModel.updateOne(
        { _id: callback._id, status: "leased", leaseToken },
        { $set: { status: "scheduled", leaseToken: "", leasedUntil: null } },
      );
      return;
    }
    if (suppressed) {
      await ScheduledCallbackModel.updateOne(
        { _id: callback._id, status: "leased", leaseToken },
        { $set: { status: "cancelled", lastError: "Contact opted out before the callback.", leaseToken: "", leasedUntil: null } },
      );
      await CampaignLeadModel.updateOne(
        {
          _id: callback.campaignLeadId,
          ownerId: callback.ownerId,
          callbackScheduledFor: callback.scheduledFor,
        },
        { $set: { callbackStatus: "cancelled", callbackScheduledFor: callback.scheduledFor } },
      );
      return;
    }
    if (!agent || !phone || phone.status !== "Ready" || !["Outbound", "Both"].includes(phone.direction)) {
      throw new Error("The callback agent or outbound phone number is not ready.");
    }
    const local = campaignLocalClock(callback.timezone, now);
    if (!isInsideCallWindow(campaign.windowStart, campaign.windowEnd, local.time)) {
      const nextAllowed = nextAllowedCallbackTime(
        callback.timezone,
        campaign.windowStart,
        campaign.windowEnd,
        now,
      );
      await ScheduledCallbackModel.updateOne(
        { _id: callback._id, status: "leased", leaseToken },
        {
          $set: {
            status: "scheduled",
            scheduledFor: nextAllowed,
            lastError: "Rescheduled to the next allowed calling window.",
            leaseToken: "",
            leasedUntil: null,
          },
        },
      );
      await CampaignLeadModel.updateOne(
        {
          _id: callback.campaignLeadId,
          ownerId: callback.ownerId,
          callbackScheduledFor: callback.scheduledFor,
        },
        { $set: { callbackStatus: "scheduled", callbackScheduledFor: nextAllowed } },
      );
      return;
    }

    await assertCallCapacity(callback.ownerId);
    const admission = await acquirePhoneNumberCallAdmission(
      callback.ownerId,
      String(callback.phoneNumberId),
      { campaignId: String(callback.campaignId) },
    );
    try {
      const result = await startOutboundCall(
        agent,
        callback.ownerId,
        callback.destination,
        admission.phone.number,
        {
          phoneNumberId: String(callback.phoneNumberId),
          callAdmission: admission,
          campaignId: String(callback.campaignId),
          campaignLeadId: String(callback.campaignLeadId),
          telephonyProvider: admission.phone.provider,
          outboundTrunkId: admission.phone.outboundTrunkId,
          metadata: {
            CampaignId: String(callback.campaignId),
            CampaignName: campaign.name,
            CampaignGoal: campaign.goal,
            SuccessCriteria: campaign.successCriteria,
            CampaignTimezone: callback.timezone,
            IsScheduledCallback: true,
            CallbackReason: callback.reason,
            CallbackRequestedText: callback.requestedText,
            CallbackScheduledAt: callback.scheduledFor.toISOString(),
            LeadPhone: callback.destination,
            LeadName: callback.callerName,
          },
          onCallCreated: async (callId) => {
            const claimed = await ScheduledCallbackModel.updateOne(
              { _id: callback._id, status: "leased", leaseToken },
              {
                $set: {
                  callId,
                  status: "calling",
                  lastAttemptAt: new Date(),
                  lastError: "",
                  leaseToken: "",
                  leasedUntil: null,
                },
                $inc: { attemptCount: 1 },
              },
            );
            if (claimed.matchedCount !== 1) throw new Error("Callback was cancelled before dialing.");
            await CampaignLeadModel.updateOne(
              { _id: callback.campaignLeadId, ownerId: callback.ownerId },
              { $set: { callbackStatus: "calling", callbackScheduledFor: callback.scheduledFor } },
            );
          },
        },
      );
      await ScheduledCallbackModel.updateOne(
        { _id: callback._id, status: "calling" },
        { $set: { callId: result.callId } },
      );
    } finally {
      await admission.release().catch(() => undefined);
    }
  } catch (error) {
    const capacityBackoff = error instanceof HttpError && error.statusCode === 429;
    const retry = capacityBackoff || callback.attemptCount + 1 < callback.maxAttempts;
    const retryAt = retry
      ? new Date(
          Date.now() + (capacityBackoff ? 30 : callback.retryGapSeconds) * 1000,
        )
      : callback.scheduledFor;
    const transitioned = await ScheduledCallbackModel.updateOne(
      { _id: callback._id, status: "leased", leaseToken },
      {
        $set: {
          status: retry ? "retry_wait" : "needs_attention",
          scheduledFor: retryAt,
          lastAttemptAt: new Date(),
          lastError: messageFrom(error),
          leaseToken: "",
          leasedUntil: null,
        },
        ...(!capacityBackoff ? { $inc: { attemptCount: 1 } } : {}),
      },
    );
    if (transitioned.matchedCount === 1) {
      await CampaignLeadModel.updateOne(
        {
          _id: callback.campaignLeadId,
          ownerId: callback.ownerId,
          callbackScheduledFor: callback.scheduledFor,
        },
        {
          $set: {
            callbackStatus: retry ? "retry_wait" : "needs_attention",
            callbackScheduledFor: retryAt,
          },
        },
      );
    }
  }
}

export async function processScheduledCallbacks() {
  if (callbackWorkerRunning) return;
  callbackWorkerRunning = true;
  try {
    await reconcileCallingCallbacks();
    const due = await ScheduledCallbackModel.find({
      status: { $in: ["scheduled", "retry_wait", "leased"] },
      scheduledFor: { $lte: new Date() },
      $or: [{ leasedUntil: null }, { leasedUntil: { $lte: new Date() } }],
    })
      .sort({ scheduledFor: 1 })
      .limit(10)
      .select("_id")
      .lean();
    for (const item of due) {
      await processDueCallback(String(item._id));
    }
  } finally {
    callbackWorkerRunning = false;
  }
}

export async function cancelScheduledCallbacksForCampaign(campaignId: string, ownerId: string) {
  await ScheduledCallbackModel.updateMany(
    {
      campaignId,
      ownerId,
      status: { $in: ["scheduled", "leased", "retry_wait"] },
    },
    {
      $set: {
        status: "cancelled",
        lastError: "Campaign cancelled by user.",
        leaseToken: "",
        leasedUntil: null,
      },
    },
  );
}
