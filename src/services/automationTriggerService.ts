import { Types } from "mongoose";
import { AutomationModel, AutomationRunModel } from "../models/Automation.js";
import { CampaignLeadModel } from "../models/CampaignLead.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { ContactSuppressionModel } from "../models/ContactSuppression.js";
import { normalizeAutomationGraph } from "./automationDefinitionService.js";

let processing = false;
const activeStatuses = ["queued", "running", "waiting"];
const phonePattern = /^\+[1-9]\d{7,14}$/;

// The cursor is advanced only after the run is durably inserted (or the source
// is known to be ineligible). Replays are harmless because eventId is unique.
export async function processAutomationTriggers(limitPerFlow = 25) {
  if (processing) return;
  processing = true;
  try {
    const flows = AutomationModel.find({ status: "live", published: { $ne: null } }).cursor();
    for await (const flow of flows) {
      try {
        const graph = normalizeAutomationGraph(flow.published as Parameters<typeof normalizeAutomationGraph>[0]);
        const trigger = graph.nodes.find((node) => node.type === "trigger");
        if (!trigger || !["contact_added", "missed_call"].includes(trigger.config.event)) continue;
        const cursor = String(flow.triggerCursor ?? "");
        const after = flow.publishedAt ?? flow.createdAt;
        const isLead = trigger.config.event === "contact_added";
        const source = isLead
          ? await CampaignLeadModel.find({
              ownerId: flow.ownerId,
              ...(trigger.config.campaignId === "all" ? {} : { campaignId: trigger.config.campaignId }),
              createdAt: { $gte: after },
              ...(cursor ? { _id: { $gt: new Types.ObjectId(cursor) } } : {}),
            }).sort({ _id: 1 }).limit(limitPerFlow)
          : await CallDetailRecordModel.find({
              ownerId: flow.ownerId, direction: "inbound", phoneNumberId: trigger.config.phoneNumberId,
              terminalFinalizedAt: { $gte: after },
              ...(cursor ? { $or: [
                { terminalFinalizedAt: { $gt: new Date(cursor.slice(0, 24)) } },
                { terminalFinalizedAt: new Date(cursor.slice(0, 24)), _id: { $gt: new Types.ObjectId(cursor.slice(25)) } },
              ] } : {}),
            }).sort({ terminalFinalizedAt: 1, _id: 1 }).limit(limitPerFlow);
        for (const item of source) {
          const call = !isLead ? item as InstanceType<typeof CallDetailRecordModel> : null;
          const lead = isLead ? item as InstanceType<typeof CampaignLeadModel> : null;
          const nextCursor = lead ? String(lead._id) : `${call!.terminalFinalizedAt!.toISOString()}|${String(call!._id)}`;
          const phone = lead?.phone ?? call?.callerNumber ?? "";
          const eligible = Boolean(phonePattern.test(phone)
            && (lead
              ? lead.automationConsentConfirmed && lead.status !== "suppressed"
              : trigger.config.consentConfirmed === "true"
                && ["completed", "failed", "cancelled"].includes(call?.status ?? "")
                && !(call?.transcript ?? []).some((turn) => turn.role === "user" && turn.text?.trim())
                && (!call?.startedAt || Number(call.durationSeconds ?? 0) <= 10 || call.status === "failed")));
          if (eligible && !await ContactSuppressionModel.exists({ ownerId: flow.ownerId, phone })) {
            if (!await AutomationModel.exists({ _id: flow._id, status: "live", publishedVersion: flow.publishedVersion })) break;
            if (await AutomationRunModel.exists({ ownerId: flow.ownerId, automationId: flow._id, contactPhone: phone, status: { $in: activeStatuses } })) break;
            if (await AutomationRunModel.countDocuments({ ownerId: flow.ownerId, status: { $in: activeStatuses } }) >= 100) break;
            const eventId = `${isLead ? "lead" : "missed"}:${String(item._id)}`;
            await AutomationRunModel.findOneAndUpdate(
              { automationId: flow._id, eventId },
              { $setOnInsert: {
                ownerId: flow.ownerId, automationId: flow._id, version: flow.publishedVersion,
                graph, eventId, contactName: lead?.name ?? "", contactPhone: phone,
                status: "queued", currentNodeId: trigger.id,
                context: { consentConfirmed: true, source: isLead ? "campaign_lead" : "inbound_missed_call", sourceId: String(item._id) },
              } },
              { upsert: true, new: true },
            );
          }
          await AutomationModel.updateOne(
            { _id: flow._id, status: "live", publishedVersion: flow.publishedVersion },
            { $max: { triggerCursor: nextCursor } },
          );
        }
      } catch (error) {
        console.error("Automation trigger scan failed.", { automationId: String(flow._id), error });
      }
    }
  } finally { processing = false; }
}
