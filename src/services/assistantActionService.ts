import { Types } from "mongoose";
import { z } from "zod";

import { AssistantPendingActionModel } from "../models/AssistantPendingAction.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { CampaignLeadModel } from "../models/CampaignLead.js";
import { CampaignModel } from "../models/Campaign.js";
import { ContactSuppressionModel } from "../models/ContactSuppression.js";
import { ScheduledCallbackModel } from "../models/ScheduledCallback.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { HttpError } from "../utils/httpError.js";
import { runAssistantTool } from "./assistantToolService.js";

const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().max(8000).optional(),
  firstMessage: z.string().trim().max(1000).optional(),
  language: z.string().trim().max(80).optional(),
  team: z.string().trim().max(120).optional(),
}).strict();

const updateAgentSchema = z.object({
  agentNameOrId: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(8000).optional(),
  firstMessage: z.string().trim().min(1).max(1000).optional(),
  language: z.string().trim().min(1).max(80).optional(),
  status: z.enum(["Live", "Draft", "Paused"]).optional(),
}).strict().refine((value) => ["prompt", "firstMessage", "language", "status"].some((key) => key in value));

const scheduleFollowUpSchema = z.object({
  leadId: z.string().regex(/^[0-9a-f]{24}$/i),
  scheduledAt: z.string().max(40).regex(/(?:Z|[+-]\d{2}:\d{2})$/i),
  reason: z.string().trim().max(300).optional(),
}).strict();

function campaignLocalTime(timezone: string, at: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function insideCallWindow(start: string, end: string, time: string) {
  return start === end || (start < end ? time >= start && time < end : time >= start || time < end);
}

export type AssistantActionPreview = {
  id: string;
  title: string;
  description: string;
  fields: Array<{ label: string; value: string }>;
  expiresAt: string;
};

export function parseAssistantWriteAction(toolName: string, rawArguments: string) {
  if (!["create_agent", "update_agent", "schedule_follow_up"].includes(toolName)) return null;
  let value: unknown;
  try {
    value = JSON.parse(rawArguments);
  } catch {
    throw new HttpError(400, "The assistant supplied invalid action details.");
  }
  const parsed = (toolName === "create_agent" ? createAgentSchema
    : toolName === "update_agent" ? updateAgentSchema : scheduleFollowUpSchema).safeParse(value);
  if (!parsed.success) throw new HttpError(400, "The assistant supplied incomplete action details. Please ask again with the specific changes.");
  return { toolName, arguments: parsed.data };
}

function actionPreview(action: { _id: unknown; toolName: string; arguments: unknown; expiresAt: Date }): AssistantActionPreview {
  const details = action.arguments as Record<string, unknown>;
  const create = action.toolName === "create_agent";
  const followUp = action.toolName === "schedule_follow_up";
  return {
    id: String(action._id),
    title: followUp ? "Schedule a follow-up call" : create ? `Create ${details.name}` : `Update ${details.agentNameOrId}`,
    description: followUp ? "This call will be scheduled only after approval." : create ? "A draft voice agent will be created in this workspace." : "These changes will be saved to the voice agent.",
    fields: Object.entries(details).map(([key, value]) => ({
      label: ({ firstMessage: "Greeting", agentNameOrId: "Agent", prompt: "Instructions", leadId: "Contact ID", scheduledAt: "Scheduled time" } as Record<string, string>)[key] ?? key.replace(/([A-Z])/g, " $1"),
      value: String(value),
    })),
    expiresAt: action.expiresAt.toISOString(),
  };
}

async function followUpContext(ownerId: string, leadId: string, scheduledAt: string) {
  const scheduledFor = new Date(scheduledAt);
  const now = Date.now();
  if (!Number.isFinite(scheduledFor.getTime()) || scheduledFor.getTime() < now + 60_000
    || scheduledFor.getTime() > now + 366 * 24 * 60 * 60_000) {
    throw new HttpError(400, "Choose an exact follow-up time between one minute and one year from now.");
  }
  const lead = await CampaignLeadModel.findOne({
    _id: leadId, ownerId,
    outcome: { $in: ["follow_up", "qualified"] },
    status: { $nin: ["suppressed", "cancelled"] },
    callbackStatus: { $nin: ["scheduled", "calling", "completed", "retry_wait"] },
    followUpStatus: { $nin: ["scheduled", "calling", "completed"] },
    conversionStatus: { $nin: ["pending", "verified"] },
  }).select("campaignId name phone outcome").lean();
  if (!lead) throw new HttpError(409, "This contact is no longer eligible for a follow-up. Refresh the candidate list.");
  const campaign = await CampaignModel.findOne({ _id: lead.campaignId, ownerId })
    .select("name status timezone windowStart windowEnd automaticCallbacks")
    .lean();
  if (!campaign || !["running", "paused"].includes(campaign.status) || !campaign.automaticCallbacks) {
    throw new HttpError(409, "Follow-up calls are not enabled for this active campaign.");
  }
  const local = campaignLocalTime(campaign.timezone, scheduledFor);
  if (!insideCallWindow(campaign.windowStart, campaign.windowEnd, local.time)) {
    throw new HttpError(409, `Choose a time inside ${campaign.windowStart}-${campaign.windowEnd} ${campaign.timezone}.`);
  }
  if (await ContactSuppressionModel.exists({ ownerId, phone: lead.phone })) {
    throw new HttpError(409, "This contact opted out and cannot be scheduled.");
  }
  const call = await CallDetailRecordModel.findOne({
    campaignId: campaign._id, campaignLeadId: lead._id, $or: [{ ownerId }, { orgId: ownerId }],
  }).sort({ createdAt: -1 }).select("livekitRoomName").lean();
  if (!call || await ScheduledCallbackModel.exists({ sourceCallId: call._id })) {
    throw new HttpError(409, "This contact has no eligible call or already has a callback for the latest call.");
  }
  return { lead, campaign, call, scheduledFor, local };
}

export async function proposeAssistantAction(ownerId: string, userId: string, toolName: string, rawArguments: string) {
  const parsed = parseAssistantWriteAction(toolName, rawArguments);
  if (!parsed) throw new HttpError(400, "That assistant action cannot be reviewed.");
  const followUpArgs = parsed.toolName === "schedule_follow_up"
    ? scheduleFollowUpSchema.parse(parsed.arguments)
    : null;
  const followUp = followUpArgs
    ? await followUpContext(ownerId, followUpArgs.leadId, followUpArgs.scheduledAt)
    : null;
  const action = await AssistantPendingActionModel.create({
    ownerId,
    userId,
    toolName: parsed.toolName,
    arguments: parsed.arguments,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const preview = actionPreview(action);
  if (followUp) {
    preview.title = `Follow up with ${followUp.lead.name || followUp.lead.phone}`;
    preview.description = `Schedule a callback in ${followUp.campaign.name}${followUp.campaign.status === "paused" ? " after the campaign resumes" : ""}.`;
    preview.fields = [
      { label: "Contact", value: `${followUp.lead.name || "Unnamed contact"} · ${followUp.lead.phone}` },
      { label: "Campaign", value: followUp.campaign.name },
      { label: "When", value: `${followUp.local.date} ${followUp.local.time} ${followUp.campaign.timezone}` },
      { label: "Reason", value: followUpArgs?.reason || "Follow-up requested" },
    ];
  }
  return preview;
}

export async function decideAssistantAction(ownerId: string, userId: string, actionId: string, approved: boolean, agentLimit?: number) {
  if (!Types.ObjectId.isValid(actionId)) throw new HttpError(404, "This action is no longer available.");
  const action = await AssistantPendingActionModel.findOneAndUpdate(
    { _id: actionId, ownerId, userId, status: "pending", expiresAt: { $gt: new Date() } },
    { $set: { status: approved ? "approved" : "declined" } },
    { new: true },
  );
  if (!action) throw new HttpError(409, "This action has expired or was already reviewed.");
  if (!approved) return { answer: "Action cancelled. No changes were made." };

  try {
    if (action.toolName === "create_agent" && agentLimit !== undefined) {
      if (await VoiceAgentModel.countDocuments({ ownerId }) >= agentLimit) {
        throw new HttpError(409, `Agent limit of ${agentLimit} reached for this plan.`);
      }
    }
    const result = action.toolName === "schedule_follow_up"
      ? await (async () => {
          const args = action.arguments as { leadId: string; scheduledAt: string; reason?: string };
          const context = await followUpContext(ownerId, args.leadId, args.scheduledAt);
          const { scheduleCampaignCallback } = await import("./scheduledCallbackService.js");
          const callback = await scheduleCampaignCallback({
            roomName: context.call.livekitRoomName,
            callbackNumber: context.lead.phone,
            callerName: context.lead.name,
            reason: args.reason || "Follow-up requested in Ask Vozon",
            scheduledAt: args.scheduledAt,
            timezone: context.campaign.timezone,
          });
          return { message: `Follow-up scheduled for ${context.lead.name || context.lead.phone} on ${context.local.date} at ${context.local.time} ${context.campaign.timezone}.`, callbackId: String(callback._id) };
        })()
      : await runAssistantTool(ownerId, action.toolName, JSON.stringify(action.arguments));
    console.info(JSON.stringify({ event: "ask-vozon-action-approved", ownerId, userId, actionId, toolName: action.toolName }));
    return { answer: String((result as { message?: string }).message ?? "The action was completed."), result };
  } catch (error) {
    await AssistantPendingActionModel.updateOne({ _id: action._id }, { $set: { status: "failed" } });
    throw error;
  }
}
