import { AutomationRunModel, AutomationWhatsAppStatusModel } from "../models/Automation.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { ContactSuppressionModel } from "../models/ContactSuppression.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { assertCallCapacity } from "./billingService.js";
import { campaignLocalClock, isInsideCallWindow } from "./campaignService.js";
import { normalizedCampaignOutcome } from "./callIntelligenceService.js";
import { startOutboundCall } from "./livekitService.js";
import { acquirePhoneNumberCallAdmission } from "./phoneNumberCallAdmissionService.js";
import { getWhatsAppTemplate, sendWhatsAppMessage } from "./whatsappService.js";
import { decryptSecret } from "../utils/secretCrypto.js";
import { normalizeAutomationGraph, whatsAppTemplateIssues, type AutomationGraph, type AutomationNode } from "./automationDefinitionService.js";

let workerRunning = false;
const leaseMs = 120_000;
const maxRunAgeMs = 90 * 24 * 60 * 60 * 1000;

function edgeTarget(graph: AutomationGraph, nodeId: string, handle: string) {
  return graph.edges.find((edge) => edge.source === nodeId && edge.sourceHandle === handle)?.target
    ?? (handle === "failed" ? undefined : graph.edges.find((edge) => edge.source === nodeId && edge.sourceHandle === "default")?.target)
    ?? "";
}

function step(node: AutomationNode, detail: string, status: "completed" | "failed" | "waiting" = "completed") {
  return { nodeId: node.id, title: node.title, type: node.type, status, detail: detail.slice(0, 500), at: new Date() };
}

function outcomeFromCall(call: { structuredOutput?: unknown; tags?: string[]; transcript?: Array<{ text?: string }>; callbackRequested?: boolean; voicemailDetected?: boolean; status: string; endReason?: string }) {
  return normalizedCampaignOutcome({
    structuredOutput: call.structuredOutput,
    tags: call.tags ?? [],
    transcript: (call.transcript ?? []).map((item) => item.text ?? "").join(" "),
    callbackRequested: call.callbackRequested,
    voicemailDetected: Boolean(call.voicemailDetected),
    status: call.status,
    endReason: call.endReason ?? "",
  });
}

export async function recoverExpiredAutomationRuns(now = new Date()) {
  const expired = { status: "running", leaseUntil: { $lt: now } };
  // A recorded call ID can be observed after a crash without placing another call.
  await AutomationRunModel.updateMany(
    { ...expired, actionType: "call", callId: { $nin: ["", null] } },
    { $set: { status: "waiting", waitKind: "call", dueAt: now, leaseUntil: null, actionType: "", actionNodeId: "" }, $inc: { __v: 1 } },
  );
  await AutomationRunModel.updateMany(
    { ...expired, actionType: "whatsapp", whatsappMessageId: { $nin: ["", null] } },
    { $set: { status: "waiting", waitKind: "whatsapp_delivery", dueAt: now, leaseUntil: null, actionType: "", actionNodeId: "" }, $inc: { __v: 1 } },
  );
  // The provider may have accepted an action before the process stopped. Never send it again automatically.
  await AutomationRunModel.updateMany(
    { ...expired, actionType: { $in: ["call", "whatsapp"] } },
    { $set: { status: "failed", error: "Action outcome is uncertain after a worker interruption. Check the provider before starting another run.", finishedAt: now, leaseUntil: null }, $inc: { __v: 1 } },
  );
  await AutomationRunModel.updateMany(
    { ...expired, actionType: { $in: ["", null] } },
    { $set: { status: "queued", dueAt: now, leaseUntil: null }, $inc: { __v: 1 } },
  );
}

export async function processAutomationRuns(limit = 20) {
  if (workerRunning) return;
  workerRunning = true;
  try {
    await recoverExpiredAutomationRuns();
    for (let count = 0; count < limit; count += 1) {
      const now = new Date();
      const run = await AutomationRunModel.findOneAndUpdate(
        { status: { $in: ["queued", "waiting"] }, $and: [{ $or: [{ dueAt: null }, { dueAt: { $lte: now } }] }, { $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }] },
        { $set: { status: "running", leaseUntil: new Date(Date.now() + leaseMs) }, $inc: { __v: 1 } },
        { sort: { createdAt: 1 }, new: true },
      );
      if (!run) break;
      if (Date.now() - run.createdAt.getTime() > maxRunAgeMs) {
        run.status = "failed"; run.error = "This run exceeded the 90-day workflow limit.";
        run.finishedAt = new Date(); run.leaseUntil = null; await run.save(); continue;
      }
      let graph: AutomationGraph;
      try { graph = normalizeAutomationGraph(run.graph as AutomationGraph); }
      catch {
        run.status = "failed"; run.error = "The stored workflow version is invalid."; run.finishedAt = new Date();
        run.leaseUntil = null; await run.save(); continue;
      }
      const node = graph.nodes.find((item) => item.id === run.currentNodeId);
      if (!node) {
        run.status = "failed"; run.error = "Current step is missing from this workflow version."; run.finishedAt = new Date();
        run.leaseUntil = null; await run.save(); continue;
      }
      try {
        if (run.waitKind === "delay") {
          run.waitKind = ""; run.dueAt = null;
          run.steps.push(step(node, `Waited ${node.config.minutes} minutes`));
          run.currentNodeId = edgeTarget(graph, node.id, "default");
        } else if (run.waitKind === "call") {
          const call = await CallDetailRecordModel.findOne({ _id: run.callId, ownerId: run.ownerId });
          const callStartedAt = String((run.context as Record<string, unknown>).callStartedAt ?? run.createdAt);
          if (!call?.terminalFinalizedAt && call && Date.now() - new Date(callStartedAt).getTime() < 24 * 60 * 60 * 1000) {
            run.status = "waiting"; run.dueAt = new Date(Date.now() + 15_000); run.leaseUntil = null; await run.save(); continue;
          }
          const outcome = call ? outcomeFromCall(call) : "unknown";
          run.context = { ...(run.context as Record<string, unknown>), outcome, callId: run.callId };
          const callFailed = !call || call.status === "failed" || call.status === "cancelled";
          run.steps.push(step(node, `Call ${call?.status ?? "unavailable"}; outcome: ${outcome}`, callFailed ? "failed" : "completed"));
          run.waitKind = ""; run.dueAt = null;
          run.currentNodeId = edgeTarget(graph, node.id, callFailed ? "failed" : "default");
        } else if (run.waitKind === "whatsapp_delivery") {
          const delivery = await AutomationWhatsAppStatusModel.findOne({ messageId: run.whatsappMessageId });
          if (delivery?.status === "failed") throw new Error(`WhatsApp delivery failed: ${delivery.error || "Meta reported a failure."}`);
          if (delivery?.status !== "delivered" && delivery?.status !== "read") {
            if (!run.whatsappSentAt || Date.now() - run.whatsappSentAt.getTime() >= 24 * 60 * 60 * 1000) throw new Error("WhatsApp delivery was not confirmed within 24 hours.");
            run.status = "waiting"; run.dueAt = new Date(Date.now() + 15_000); run.leaseUntil = null; await run.save(); continue;
          }
          run.steps.push(step(node, `WhatsApp ${delivery.status}: ${run.whatsappMessageId}`));
          run.context = { ...(run.context as Record<string, unknown>), whatsappStatus: delivery.status, whatsappMessageId: run.whatsappMessageId };
          run.waitKind = ""; run.dueAt = null;
          run.currentNodeId = edgeTarget(graph, node.id, "default");
        } else if (node.type === "trigger") {
          run.steps.push(step(node, `${node.config.event.replaceAll("_", " ")} event received`));
          run.currentNodeId = edgeTarget(graph, node.id, "default");
        } else if (node.type === "wait") {
          run.steps.push(step(node, `Waiting ${node.config.minutes} minutes`, "waiting"));
          run.status = "waiting"; run.waitKind = "delay";
          run.dueAt = new Date(Date.now() + Number(node.config.minutes) * 60_000);
          run.leaseUntil = null; await run.save(); continue;
        } else if (node.type === "decision" || node.type === "condition") {
          const context = (run.context as Record<string, unknown>) || {};
          const callOutcome = String(context.outcome ?? "unknown");
          const whatsappStatus = String(context.whatsappStatus ?? "");
          const whatsappReply = String(context.whatsappReply ?? context.lastMessageText ?? "");

          let handle = "default";
          let detailLabel = "";

          if (node.type === "condition") {
            const conditionType = node.config.conditionType || "outcome";
            const targetVal = String(node.config.value || "").toLowerCase().trim();
            let matches = false;

            if (conditionType === "whatsapp_reply_contains") {
              matches = whatsappReply.toLowerCase().includes(targetVal);
              detailLabel = `WhatsApp reply contains "${targetVal}"`;
            } else if (conditionType === "whatsapp_reply_equals") {
              matches = whatsappReply.toLowerCase().trim() === targetVal;
              detailLabel = `WhatsApp reply == "${targetVal}"`;
            } else if (conditionType === "whatsapp_status") {
              matches = whatsappStatus.toLowerCase() === targetVal;
              detailLabel = `WhatsApp status == "${targetVal}"`;
            } else if (conditionType === "has_replied") {
              matches = Boolean(whatsappReply.trim());
              detailLabel = "Customer has replied";
            } else if (conditionType === "contact_tag") {
              const tags = Array.isArray(context.tags) ? (context.tags as string[]) : [];
              matches = tags.some((t) => t.toLowerCase() === targetVal);
              detailLabel = `Tag == "${targetVal}"`;
            } else {
              matches = callOutcome.toLowerCase() === targetVal;
              detailLabel = `Call outcome == "${node.config.value}"`;
            }
            handle = matches ? "yes" : "no";
            run.steps.push(step(node, `${detailLabel} → ${handle.toUpperCase()}`));
          } else {
            const decisionType = node.config.decisionType || "call";
            if (decisionType === "whatsapp") {
              const lowerReply = whatsappReply.toLowerCase();
              if (["yes", "interested", "book", "confirm", "sure", "ok"].some((w) => lowerReply.includes(w))) {
                handle = "interested";
              } else if (["later", "reschedule", "call", "callback", "busy"].some((w) => lowerReply.includes(w))) {
                handle = "callback";
              } else if (["no", "stop", "cancel", "not interested", "unsubscribe"].some((w) => lowerReply.includes(w))) {
                handle = "not_interested";
              } else {
                handle = "unknown";
              }
              run.steps.push(step(node, `WhatsApp sentiment "${whatsappReply.slice(0, 30)}" → ${handle}`));
            } else {
              handle = callOutcome === "qualified" ? "interested" : callOutcome === "follow_up" ? "callback" : callOutcome === "not_interested" ? "not_interested" : "unknown";
              run.steps.push(step(node, `Call outcome ${callOutcome} → ${handle}`));
            }
          }
          run.currentNodeId = edgeTarget(graph, node.id, handle);
        } else if (node.type === "end") {
          run.steps.push(step(node, node.config.outcome || node.title));
          run.status = "completed"; run.finishedAt = new Date(); run.currentNodeId = "";
        } else if (node.type === "call") {
          if ((run.context as Record<string, unknown>).consentConfirmed !== true) throw new Error("Contact consent was not confirmed for this call.");
          const agent = await VoiceAgentModel.findOne({ _id: node.config.agentId, ownerId: run.ownerId, status: "Live" });
          const phone = await PhoneNumberModel.findOne({ _id: node.config.phoneNumberId, ownerId: run.ownerId, agentId: node.config.agentId, status: "Ready", direction: { $in: ["Outbound", "Both"] } });
          if (!agent || !phone) throw new Error("Configured agent or outbound number is unavailable.");
          if (await ContactSuppressionModel.exists({ ownerId: run.ownerId, phone: run.contactPhone })) throw new Error("Contact is on the do-not-call list.");
          const timezone = node.config.timezone || "Asia/Kolkata";
          const local = campaignLocalClock(timezone);
          if (!isInsideCallWindow(node.config.windowStart || "09:00", node.config.windowEnd || "18:00", local.time)) {
            run.status = "waiting"; run.waitKind = "window"; run.dueAt = new Date(Date.now() + 5 * 60_000);
            run.leaseUntil = null; await run.save(); continue;
          }
          await assertCallCapacity(run.ownerId);
          run.actionType = "call"; run.actionNodeId = node.id;
          await run.save();
          const admission = await acquirePhoneNumberCallAdmission(run.ownerId, phone.id);
          try {
            const result = await startOutboundCall(agent, run.ownerId, run.contactPhone, phone.number, {
              phoneNumberId: phone.id, callAdmission: admission, telephonyProvider: phone.provider,
              outboundTrunkId: phone.outboundTrunkId,
              metadata: { automationId: String(run.automationId), automationRunId: run.id, automationVersion: run.version },
              onCallCreated: async (callId) => { await AutomationRunModel.updateOne({ _id: run._id }, { $set: { callId, "context.callStartedAt": new Date().toISOString() } }); },
            });
            run.callId = result.callId;
          } finally { await admission.release(); }
          run.status = "waiting"; run.waitKind = "call"; run.dueAt = new Date(Date.now() + 15_000);
          run.actionType = ""; run.actionNodeId = "";
          run.context = { ...(run.context as Record<string, unknown>), callStartedAt: new Date().toISOString() };
          run.steps.push(step(node, `Call started: ${run.callId}`, "waiting"));
          run.leaseUntil = null; await run.save(); continue;
        } else if (node.type === "whatsapp") {
          if ((run.context as Record<string, unknown>).consentConfirmed !== true) throw new Error("Contact consent was not confirmed for this message.");
          if (await ContactSuppressionModel.exists({ ownerId: run.ownerId, phone: run.contactPhone })) throw new Error("Contact is on the suppression list.");
          const integration = await ProviderIntegrationModel.findOne({ ownerId: run.ownerId, provider: "whatsapp", status: "connected" }).select("+secretEncrypted");
          if (!integration?.secretEncrypted) throw new Error("WhatsApp is not connected.");
          const token = decryptSecret(integration.secretEncrypted);
          const wabaId = String((integration.metadata as Record<string, unknown> | null)?.wabaId ?? "");
          const template = await getWhatsAppTemplate(wabaId, token, node.config.templateName, node.config.language);
          if (!template || template.status !== "APPROVED" || whatsAppTemplateIssues(node, template).length) {
            throw new Error("WhatsApp template is no longer approved or its variables changed.");
          }
          const variables = (node.config.bodyVariables || "").split(",").map((value) => value.trim()).filter(Boolean)
            .map((value) => {
              if (value === "{{name}}") return run.contactName || "Customer";
              if (value === "{{phone}}") return run.contactPhone;
              if (value === "{{outcome}}") return String((run.context as Record<string, unknown>)?.outcome || "Consultation");
              if (value === "{{summary}}") return String((run.context as Record<string, unknown>)?.callSummary || "Details discussed on call");
              return value;
            });
          const components = variables.length ? [{ type: "body", parameters: variables.map((text) => ({ type: "text", text })) }] : undefined;
          run.actionType = "whatsapp"; run.actionNodeId = node.id;
          await run.save();
          const result = await sendWhatsAppMessage(integration.accountId, token, run.contactPhone, {
            type: "template", template: { name: node.config.templateName, language: { code: node.config.language }, components },
          });
          run.whatsappMessageId = result.messageId;
          run.whatsappSentAt = new Date();
          await AutomationRunModel.updateOne({ _id: run._id }, { $set: { whatsappMessageId: run.whatsappMessageId, whatsappSentAt: run.whatsappSentAt } });
          run.steps.push(step(node, `Meta accepted message ${result.messageId}; awaiting delivery`, "waiting"));
          run.actionType = ""; run.actionNodeId = "";
          run.status = "waiting"; run.waitKind = "whatsapp_delivery"; run.dueAt = new Date(Date.now() + 15_000);
          run.leaseUntil = null; await run.save(); continue;
        } else throw new Error("This block has no live adapter.");
        if (run.status === "running") run.status = "queued";
        if (!run.currentNodeId && run.status !== "completed") throw new Error("No connection for the selected branch.");
        run.leaseUntil = null;
        await run.save();
      } catch (error) {
        if (error instanceof Error && error.name === "VersionError") continue;
        run.status = "failed";
        run.error = error instanceof Error ? error.message.slice(0, 500) : "Workflow step failed.";
        run.steps.push(step(node, run.error, "failed"));
        run.finishedAt = new Date(); run.leaseUntil = null; run.actionType = ""; run.actionNodeId = "";
        await run.save();
      }
    }
  } finally { workerRunning = false; }
}
