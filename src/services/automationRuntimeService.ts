import { AutomationRunModel, AutomationWhatsAppStatusModel } from "../models/Automation.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { ContactSuppressionModel } from "../models/ContactSuppression.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import {
  WhatsAppContactModel,
  WhatsAppConversationModel,
  WhatsAppMessageModel,
  WhatsAppTemplateModel,
} from "../models/WhatsAppEntities.js";
import { assertCallCapacity } from "./billingService.js";
import { campaignLocalClock, isInsideCallWindow } from "./campaignService.js";
import { normalizedCampaignOutcome } from "./callIntelligenceService.js";
import { startOutboundCall } from "./livekitService.js";
import { acquirePhoneNumberCallAdmission } from "./phoneNumberCallAdmissionService.js";
import { cleanPhoneNumber, getWhatsAppTemplate, sendWhatsAppMessage } from "./whatsappService.js";
import { decryptSecret } from "../utils/secretCrypto.js";
import {
  bookConnectedCalendars,
  createRazorpayPaymentLinkForOrg,
  notifyConnectedSlack,
  syncLeadToConnectedCrms,
} from "./workflowIntegrationsService.js";
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
            const lowerReply = whatsappReply.toLowerCase();
            if (decisionType === "whatsapp") {
              if (["yes", "interested", "book", "confirm", "sure", "ok", "price", "demo"].some((w) => lowerReply.includes(w))) {
                handle = "interested";
              } else if (["later", "reschedule", "call", "callback", "busy", "tomorrow"].some((w) => lowerReply.includes(w))) {
                handle = "callback";
              } else if (["no", "stop", "cancel", "not interested", "unsubscribe"].some((w) => lowerReply.includes(w))) {
                handle = "not_interested";
              } else {
                handle = "unknown";
              }
              run.steps.push(step(node, `WhatsApp sentiment "${whatsappReply.slice(0, 30)}" → ${handle}`));
            } else if (decisionType === "agentic") {
              // Autonomous AI Agent evaluation across both Voice Call outcome and WhatsApp reply
              if (callOutcome === "qualified" || ["yes", "interested", "book", "confirm", "sure", "demo", "pricing", "buy"].some((w) => lowerReply.includes(w))) {
                handle = "interested";
              } else if (callOutcome === "follow_up" || ["later", "reschedule", "call", "callback", "tomorrow", "busy"].some((w) => lowerReply.includes(w))) {
                handle = "callback";
              } else if (callOutcome === "not_interested" || ["no", "stop", "cancel", "not interested", "unsubscribe"].some((w) => lowerReply.includes(w))) {
                handle = "not_interested";
              } else {
                handle = "unknown";
              }
              run.steps.push(step(node, `AI Agentic Router (call=${callOutcome}, chat="${whatsappReply.slice(0, 24)}") → ${handle}`));
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
          const isAutoAgent = !node.config.agentId || node.config.agentId === "auto";
          const agent = isAutoAgent
            ? (await VoiceAgentModel.findOne({ ownerId: run.ownerId, status: "Live" }).sort({ updatedAt: -1 })) ||
            (await VoiceAgentModel.findOne({ ownerId: run.ownerId }).sort({ updatedAt: -1 }))
            : await VoiceAgentModel.findOne({ _id: node.config.agentId, ownerId: run.ownerId });

          const isAutoPhone = !node.config.phoneNumberId || node.config.phoneNumberId === "auto";
          const phone = isAutoPhone
            ? (agent
              ? await PhoneNumberModel.findOne({ ownerId: run.ownerId, agentId: agent._id, status: "Ready", direction: { $in: ["Outbound", "Both"] } })
              : null) ||
            (await PhoneNumberModel.findOne({ ownerId: run.ownerId, status: "Ready", direction: { $in: ["Outbound", "Both"] } }))
            : await PhoneNumberModel.findOne({ _id: node.config.phoneNumberId, ownerId: run.ownerId });

          if (!agent || !phone) throw new Error("Configured voice agent or outbound phone number is unavailable.");
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
          run.steps.push(step(node, `Call started (${agent.name} via ${phone.number}): ${run.callId}`, "waiting"));
          run.leaseUntil = null; await run.save(); continue;
        } else if (node.type === "whatsapp") {
          if ((run.context as Record<string, unknown>).consentConfirmed !== true) throw new Error("Contact consent was not confirmed for this message.");
          if (await ContactSuppressionModel.exists({ ownerId: run.ownerId, phone: run.contactPhone })) throw new Error("Contact is on the suppression list.");

          const integrations = await ProviderIntegrationModel.find({
            ownerId: run.ownerId,
            provider: "whatsapp",
            status: "connected",
          }).select("+secretEncrypted").sort({ createdAt: 1 });

          const preferredPhoneId = node.config.senderPhoneNumberId?.trim();
          const integration =
            (preferredPhoneId && preferredPhoneId !== "auto"
              ? integrations.find((i) => i.accountId === preferredPhoneId)
              : undefined) ||
            integrations.find((i) => Boolean((i.metadata as Record<string, unknown> | undefined)?.isPrimary)) ||
            integrations[0];

          const runCtx = (run.context as Record<string, unknown>) || {};
          const replaceVars = (raw: string) =>
            raw
              .replace(/\{\{name\}\}/gi, run.contactName || "Customer")
              .replace(/\{\{phone\}\}/gi, run.contactPhone)
              .replace(/\{\{outcome\}\}/gi, String(runCtx.outcome || "Consultation"))
              .replace(/\{\{summary\}\}/gi, String(runCtx.callSummary || "Details discussed on call"))
              .replace(/\{\{paymentLink\}\}/gi, String(runCtx.paymentLink || ""))
              .replace(/\{\{calendlyLink\}\}/gi, String(runCtx.calendlyLink || runCtx.calendarHtmlLink || ""))
              .replace(/\{\{calendarTime\}\}/gi, String(runCtx.appointmentSlot || ""))
              .replace(/\{\{crmStage\}\}/gi, String(runCtx.crmStage || "Qualified"));

          const localTemplate = node.config.templateName
            ? await WhatsAppTemplateModel.findOne({ ownerId: run.ownerId, name: node.config.templateName }).catch(() => null)
            : null;

          let renderedText = "";
          if (node.config.messageMode === "ai_dynamic") {
            const promptHint = node.config.aiPrompt || "Follow up warmly with the customer regarding their inquiry and next steps.";
            renderedText = replaceVars(
              `Hi ${run.contactName || "there"}! 👋 ${promptHint}\n\nReply anytime if you'd like to schedule or speak with our specialist.`,
            );
          } else if (localTemplate) {
            const vars = (node.config.bodyVariables || "")
              .split(",")
              .map((v) => replaceVars(v.trim()))
              .filter(Boolean);
            renderedText = localTemplate.bodyText;
            vars.forEach((val, idx) => {
              renderedText = renderedText.replace(new RegExp(`\\{\\{${idx + 1}\\}\\}`, "g"), val);
            });
            renderedText = replaceVars(renderedText);
          } else {
            renderedText = replaceVars(
              node.config.aiPrompt ||
              `Hello ${run.contactName || "Customer"}, thank you for connecting with us! Reply to this message to continue.`,
            );
          }

          let metaMessageId = `sim_${Date.now()}`;
          if (integration?.secretEncrypted) {
            const token = decryptSecret(integration.secretEncrypted);
            const wabaId = String((integration.metadata as Record<string, unknown> | null)?.wabaId ?? "");
            try {
              if (node.config.messageMode !== "ai_dynamic" && wabaId && node.config.templateName) {
                const metaTemplate = await getWhatsAppTemplate(wabaId, token, node.config.templateName, node.config.language || "en").catch(() => null);
                if (metaTemplate && metaTemplate.status === "APPROVED" && !whatsAppTemplateIssues(node, metaTemplate).length) {
                  const variables = (node.config.bodyVariables || "")
                    .split(",")
                    .map((value) => replaceVars(value.trim()))
                    .filter(Boolean);
                  const components = variables.length ? [{ type: "body", parameters: variables.map((text) => ({ type: "text", text })) }] : undefined;
                  const result = await sendWhatsAppMessage(integration.accountId, token, run.contactPhone, {
                    type: "template",
                    template: { name: node.config.templateName, language: { code: node.config.language || "en" }, components },
                  });
                  metaMessageId = result.messageId;
                } else {
                  const result = await sendWhatsAppMessage(integration.accountId, token, run.contactPhone, {
                    type: "text",
                    text: renderedText,
                  });
                  metaMessageId = result.messageId;
                }
              } else {
                const result = await sendWhatsAppMessage(integration.accountId, token, run.contactPhone, {
                  type: "text",
                  text: renderedText,
                });
                metaMessageId = result.messageId;
              }
            } catch (err) {
              console.warn("Workflow WhatsApp live send fallback:", err);
            }
          }

          // Also record in WhatsApp Live Chat conversation so staff can see it
          const cleanPhone = cleanPhoneNumber(run.contactPhone);
          const conv = await WhatsAppConversationModel.findOneAndUpdate(
            { ownerId: run.ownerId, contactPhone: cleanPhone },
            {
              $set: {
                contactName: run.contactName || "Customer",
                lastMessageText: renderedText,
                lastMessageTimestamp: new Date(),
                ...(integration?.accountId ? { recipientPhoneNumberId: integration.accountId } : {}),
              },
              $setOnInsert: {
                ownerId: run.ownerId,
                contactPhone: cleanPhone,
                status: "open",
                mode: "ai",
                tags: ["Workflow"],
              },
            },
            { upsert: true, new: true },
          );
          await WhatsAppMessageModel.create({
            ownerId: run.ownerId,
            conversationId: conv._id,
            direction: "outbound",
            senderPhone: String((integration?.metadata as Record<string, unknown> | undefined)?.displayPhoneNumber || "Workflow AI"),
            recipientPhone: cleanPhone,
            type: node.config.messageMode === "ai_dynamic" ? "text" : "template",
            content: renderedText,
            status: "delivered",
            metaMessageId,
          });

          run.whatsappMessageId = metaMessageId;
          run.whatsappSentAt = new Date();
          run.context = { ...(run.context as Record<string, unknown>), whatsappStatus: "delivered", whatsappMessageId: metaMessageId };
          run.steps.push(step(node, `WhatsApp sent (${node.config.templateName || "AI Message"}): ${metaMessageId}`));
          run.currentNodeId = edgeTarget(graph, node.id, "default");
        } else if (node.type === "payment") {
          const amount = Number(node.config.amount || 999);
          const currency = (node.config.currency || "INR").toUpperCase();
          const paymentDesc = (node.config.description || "Payment Request via Vozon AI")
            .replace(/\{\{name\}\}/gi, run.contactName || "Customer");

          const linkResult = await createRazorpayPaymentLinkForOrg(run.ownerId, {
            amount,
            currency,
            description: paymentDesc,
            customerName: run.contactName || "Customer",
            customerPhone: run.contactPhone,
            referenceId: String(run._id),
          });

          const cleanPhone = cleanPhoneNumber(run.contactPhone);
          let whatsappMsgId = "";
          if (node.config.sendWhatsApp !== "false") {
            const integrations = await ProviderIntegrationModel.find({
              ownerId: run.ownerId,
              provider: "whatsapp",
              status: "connected",
            }).select("+secretEncrypted").sort({ createdAt: 1 });
            const preferredWa = node.config.senderPhoneNumberId?.trim();
            const waConn =
              (preferredWa && preferredWa !== "auto"
                ? integrations.find((i) => i.accountId === preferredWa)
                : undefined) ||
              integrations.find((i) => Boolean((i.metadata as Record<string, unknown> | undefined)?.isPrimary)) ||
              integrations[0];

            const payText = `Hi ${run.contactName || "there"}! 💳 Here is your secure Razorpay payment link for *${currency} ${amount.toLocaleString("en-IN")}* (${paymentDesc}):\n\n${linkResult.shortUrl}\n\nThank you!`;
            if (waConn?.secretEncrypted) {
              try {
                const token = decryptSecret(waConn.secretEncrypted);
                const sent = await sendWhatsAppMessage(waConn.accountId, token, run.contactPhone, {
                  type: "text",
                  text: payText,
                });
                whatsappMsgId = sent.messageId;
              } catch (err) {
                console.warn("Payment link WhatsApp dispatch failed:", err);
              }
            }
            const conv = await WhatsAppConversationModel.findOneAndUpdate(
              { ownerId: run.ownerId, contactPhone: cleanPhone },
              {
                $set: {
                  contactName: run.contactName || "Customer",
                  lastMessageText: payText,
                  lastMessageTimestamp: new Date(),
                  ...(waConn?.accountId ? { recipientPhoneNumberId: waConn.accountId } : {}),
                },
                $setOnInsert: { ownerId: run.ownerId, contactPhone: cleanPhone, status: "open", mode: "ai", tags: ["Payment"] },
              },
              { upsert: true, new: true },
            );
            await WhatsAppMessageModel.create({
              ownerId: run.ownerId,
              conversationId: conv._id,
              direction: "outbound",
              senderPhone: String((waConn?.metadata as Record<string, unknown> | undefined)?.displayPhoneNumber || "Razorpay Automation"),
              recipientPhone: cleanPhone,
              type: "text",
              content: payText,
              status: "delivered",
              metaMessageId: whatsappMsgId || `pay_${linkResult.id}`,
            });
          }

          await WhatsAppContactModel.findOneAndUpdate(
            { ownerId: run.ownerId, phoneNumber: cleanPhone },
            {
              $set: {
                name: run.contactName || "Customer",
                lastContactedAt: new Date(),
                "customAttributes.lastPaymentLink": linkResult.shortUrl,
                "customAttributes.lastPaymentLinkId": linkResult.id,
              },
              $addToSet: { tags: "Payment-Link-Sent" },
            },
            { upsert: true, new: true },
          );

          run.context = {
            ...(run.context as Record<string, unknown>),
            paymentLink: linkResult.shortUrl,
            paymentLinkId: linkResult.id,
            paymentAmount: `${currency} ${amount}`,
          };
          run.steps.push(step(node, `Razorpay link (${currency} ${amount}) created${whatsappMsgId ? " & sent on WhatsApp" : ""}: ${linkResult.shortUrl}`));
          run.currentNodeId = edgeTarget(graph, node.id, "default");
        } else if (node.type === "crm") {
          const crmStage = node.config.crmStage || "Qualified";
          const crmTag = node.config.crmTag || "CRM-Synced";
          const cleanPhone = cleanPhoneNumber(run.contactPhone);
          await WhatsAppContactModel.findOneAndUpdate(
            { ownerId: run.ownerId, phoneNumber: cleanPhone },
            {
              $set: {
                name: run.contactName || "Customer",
                lastContactedAt: new Date(),
                "customAttributes.crmStage": crmStage,
                "customAttributes.lastWorkflowId": String(run.automationId),
              },
              $addToSet: { tags: { $each: [crmTag, crmStage] } },
            },
            { upsert: true, new: true },
          );

          // Push to all connected external CRMs & Google Sheets (HubSpot, Zoho, Salesforce, HighLevel, Freshsales, Google Sheets)
          const crmSync = await syncLeadToConnectedCrms(run.ownerId, {
            contactName: run.contactName || "Customer",
            contactPhone: run.contactPhone,
            stage: crmStage,
            tag: crmTag,
            outcome: String((run.context as Record<string, unknown>)?.outcome || ""),
            summary: String((run.context as Record<string, unknown>)?.callSummary || ""),
            spreadsheetId: node.config.spreadsheetId?.trim() || undefined,
          });

          if (node.config.webhookUrl && /^https?:\/\//i.test(node.config.webhookUrl)) {
            await fetch(node.config.webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                event: "workflow.crm_sync",
                contactName: run.contactName,
                contactPhone: run.contactPhone,
                stage: crmStage,
                tag: crmTag,
                context: run.context,
              }),
            }).catch(() => undefined);
          }
          const existingTags = Array.isArray((run.context as Record<string, unknown>)?.tags)
            ? ((run.context as Record<string, unknown>).tags as string[])
            : [];
          run.context = {
            ...(run.context as Record<string, unknown>),
            crmStage,
            tags: Array.from(new Set([...existingTags, crmTag, crmStage])),
          };
          const syncedStr = crmSync.syncedProviders.length
            ? ` → ${crmSync.syncedProviders.join(", ")}`
            : " (Vozon CRM)";
          run.steps.push(step(node, `CRM synced${syncedStr}: stage="${crmStage}", tag="${crmTag}"`));
          run.currentNodeId = edgeTarget(graph, node.id, "default");
        } else if (node.type === "calendar") {
          const meetingTitle = node.config.calendarTitle || "AI Consultation Call";
          const durationMins = Number(node.config.durationMinutes || 30);
          const cleanPhone = cleanPhoneNumber(run.contactPhone);

          const calRes = await bookConnectedCalendars(run.ownerId, {
            title: meetingTitle,
            durationMinutes: durationMins,
            customerName: run.contactName || "Customer",
            customerPhone: run.contactPhone,
            timezone: node.config.timezone || "Asia/Kolkata",
          });

          await WhatsAppContactModel.findOneAndUpdate(
            { ownerId: run.ownerId, phoneNumber: cleanPhone },
            {
              $set: {
                name: run.contactName || "Customer",
                lastContactedAt: new Date(),
                "customAttributes.appointmentTitle": meetingTitle,
                "customAttributes.appointmentSlot": calRes.scheduledStartIso,
                "customAttributes.appointmentDuration": `${durationMins}m`,
                ...(calRes.calendlyLink ? { "customAttributes.calendlyLink": calRes.calendlyLink } : {}),
                ...(calRes.calendarHtmlLink ? { "customAttributes.googleCalendarLink": calRes.calendarHtmlLink } : {}),
              },
              $addToSet: { tags: "Appointment-Booked" },
            },
            { upsert: true, new: true },
          );
          run.context = {
            ...(run.context as Record<string, unknown>),
            appointmentBooked: true,
            appointmentTitle: meetingTitle,
            appointmentSlot: calRes.scheduledStartIso,
            ...(calRes.calendlyLink ? { calendlyLink: calRes.calendlyLink } : {}),
            ...(calRes.calendarHtmlLink ? { calendarHtmlLink: calRes.calendarHtmlLink } : {}),
          };
          const calTargetStr = calRes.syncedProviders.length
            ? ` via ${calRes.syncedProviders.join(" + ")}`
            : "";
          run.steps.push(step(node, `Calendar booked${calTargetStr}: "${meetingTitle}" (${durationMins} min)`));
          run.currentNodeId = edgeTarget(graph, node.id, "default");
        } else if (node.type === "sms") {
          const msgText = (node.config.messageText || "Hi {{name}}, thank you for connecting with us! We will follow up shortly.")
            .replace(/\{\{name\}\}/gi, run.contactName || "Customer")
            .replace(/\{\{phone\}\}/gi, run.contactPhone)
            .replace(/\{\{outcome\}\}/gi, String((run.context as Record<string, unknown>)?.outcome || "Completed"))
            .replace(/\{\{paymentLink\}\}/gi, String((run.context as Record<string, unknown>)?.paymentLink || ""))
            .replace(/\{\{calendlyLink\}\}/gi, String((run.context as Record<string, unknown>)?.calendlyLink || ""));
          const slackSent = await notifyConnectedSlack(
            run.ownerId,
            `🔔 *Vozon Workflow Alert* (${run.contactName || run.contactPhone})\n${msgText}`,
          ).catch(() => false);
          run.steps.push(step(node, `${slackSent ? "Slack + " : ""}Instant notification dispatched: "${msgText.slice(0, 80)}"`));
          run.currentNodeId = edgeTarget(graph, node.id, "default");
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
