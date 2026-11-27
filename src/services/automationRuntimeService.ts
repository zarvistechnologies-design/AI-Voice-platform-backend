import { AutomationModel, AutomationRunModel, AutomationWhatsAppStatusModel } from "../models/Automation.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { ContactSuppressionModel } from "../models/ContactSuppression.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import {
  WhatsAppContactModel,
  WhatsAppConversationModel,
  WhatsAppMessageModel,
  WhatsAppSupportCaseModel,
  WhatsAppTemplateModel,
} from "../models/WhatsAppEntities.js";
import { assertCallCapacity } from "./billingService.js";
import { campaignLocalClock, isInsideCallWindow } from "./campaignService.js";
import { normalizedCampaignOutcome } from "./callIntelligenceService.js";
import { callUsesFailedBranch } from "./automationCallBranch.js";
import { startOutboundCall } from "./livekitService.js";
import { acquirePhoneNumberCallAdmission } from "./phoneNumberCallAdmissionService.js";
import { cleanPhoneNumber, getWhatsAppTemplate, sendWhatsAppMessage } from "./whatsappService.js";
import { findWhatsAppConversationForLine } from "./whatsappCoexistenceService.js";
import { decryptSecret } from "../utils/secretCrypto.js";
import {
  bookConnectedCalendars,
  createRazorpayPaymentLinkForOrg,
  notifyConnectedSlack,
  syncLeadToConnectedCrms,
} from "./workflowIntegrationsService.js";
import { normalizeAutomationGraph, whatsAppTemplateIssues, type AutomationGraph, type AutomationNode } from "./automationDefinitionService.js";
import { evaluateAgenticDecision, generateDynamicWhatsAppMessage } from "./automationDecisionService.js";

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

async function upsertAutomationWhatsAppConversation(params: {
  ownerId: string;
  contactPhone: string;
  contactName: string;
  lastMessageText: string;
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  tags: string[];
}) {
  const existing = await findWhatsAppConversationForLine(params.ownerId, params.contactPhone, params.phoneNumberId);
  if (existing) {
    existing.contactName = params.contactName || existing.contactName || "Customer";
    existing.lastMessageText = params.lastMessageText;
    existing.lastMessageTimestamp = new Date();
    if (params.phoneNumberId) existing.recipientPhoneNumberId = params.phoneNumberId;
    if (params.displayPhoneNumber) existing.recipientDisplayPhone = params.displayPhoneNumber;
    await existing.save();
    return existing;
  }
  return WhatsAppConversationModel.create({
    ownerId: params.ownerId,
    contactPhone: params.contactPhone,
    contactName: params.contactName || "Customer",
    recipientPhoneNumberId: params.phoneNumberId || "",
    recipientDisplayPhone: params.displayPhoneNumber || "",
    lastMessageText: params.lastMessageText,
    lastMessageTimestamp: new Date(),
    unreadCount: 0,
    status: "open",
    mode: "ai",
    tags: params.tags,
  });
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
        } else if (run.waitKind === "whatsapp_reply") {
          const ctx = (run.context as Record<string, unknown>) || {};
          const matched = ctx.waitReplyMatched === true;
          run.waitKind = ""; run.dueAt = null;
          run.context = { ...ctx, waitReplyMatched: false };
          run.steps.push(step(node, matched
            ? `WhatsApp reply received ("${String(ctx.whatsappReply || "").slice(0, 50)}") — resumed immediately`
            : `Wait timed out after ${node.config.minutes || "60"} min with no WhatsApp reply`));
          run.currentNodeId = edgeTarget(graph, node.id, "default");
        } else if (run.waitKind === "payment_paid") {
          const ctx = (run.context as Record<string, unknown>) || {};
          const paid = ctx.paymentPaid === true;
          run.waitKind = ""; run.dueAt = null;
          run.steps.push(step(node, paid
            ? `Razorpay payment confirmed (${String(ctx.paidAmount || ctx.paymentAmount || "paid")}) — resumed immediately`
            : `Wait timed out after ${node.config.minutes || "60"} min without payment`));
          run.currentNodeId = edgeTarget(graph, node.id, "default");
        } else if (run.waitKind === "case_resolved") {
          const ctx = (run.context as Record<string, unknown>) || {};
          let caseStatus = String(ctx.caseStatus || "open").toLowerCase();
          if (caseStatus !== "resolved" && (ctx.caseId || ctx.caseNumber)) {
            const liveCase = await WhatsAppSupportCaseModel.findOne({
              ownerId: run.ownerId,
              ...(ctx.caseId ? { _id: ctx.caseId } : { caseNumber: String(ctx.caseNumber) }),
            }).lean().catch(() => null);
            if (liveCase?.status) {
              caseStatus = String(liveCase.status).toLowerCase();
              run.context = { ...ctx, caseStatus, caseResolved: caseStatus === "resolved" };
            }
          }
          const resolved = caseStatus === "resolved" || ctx.caseResolved === true;
          run.waitKind = ""; run.dueAt = null;
          run.steps.push(step(node, resolved
            ? `Support case ${String(ctx.caseNumber || "").trim() || "(active)"} resolved — resumed immediately`
            : `SLA wait timed out after ${node.config.minutes || "60"} min (case status: ${caseStatus})`));
          run.currentNodeId = edgeTarget(graph, node.id, "default");
        } else if (run.waitKind === "call_retry") {
          // Retry delay elapsed: clear waitKind and fall through to re-execute the call node on the next tick
          run.waitKind = ""; run.dueAt = null;
          run.status = "queued";
          run.steps.push(step(node, "Retry backoff finished — placing retry call"));
          run.leaseUntil = null;
          await run.save();
          continue;
        } else if (run.waitKind === "call") {
          const call = await CallDetailRecordModel.findOne({ _id: run.callId, ownerId: run.ownerId });
          const callStartedAt = String((run.context as Record<string, unknown>).callStartedAt ?? run.createdAt);
          if (!call?.terminalFinalizedAt && call && Date.now() - new Date(callStartedAt).getTime() < 24 * 60 * 60 * 1000) {
            run.status = "waiting"; run.dueAt = new Date(Date.now() + 15_000); run.leaseUntil = null; await run.save(); continue;
          }
          const outcome = call ? outcomeFromCall(call) : "unknown";
          const structured = (call?.structuredOutput && typeof call.structuredOutput === "object")
            ? (call.structuredOutput as Record<string, unknown>)
            : null;
          const transcriptSnippet = (call?.transcript ?? [])
            .map((turn) => {
              const text = (turn.text ?? "").trim();
              if (!text) return "";
              return `${turn.role === "user" ? "Customer" : "Assistant"}: ${text}`;
            })
            .filter(Boolean)
            .slice(-6)
            .join("\n")
            .slice(-1200);
          const callSummaryParts = [
            structured?.summary,
            structured?.callSummary,
            structured?.notes,
            call?.callbackDetails?.reason,
          ].map((value) => String(value ?? "").trim()).filter(Boolean);
          if (transcriptSnippet) callSummaryParts.push(transcriptSnippet);
          const callSummary = callSummaryParts.join("\n").slice(-1600);
          const prevCtx = (run.context as Record<string, unknown>) || {};
          const attemptsMap = (prevCtx.callAttemptsByNode && typeof prevCtx.callAttemptsByNode === "object")
            ? { ...(prevCtx.callAttemptsByNode as Record<string, number>) }
            : {};
          const attemptNum = Number(attemptsMap[node.id] ?? 1);
          const maxRetries = Math.min(5, Math.max(0, Number(node.config.maxRetries || 0) || 0));
          const retryDelayMin = Math.min(1440, Math.max(1, Number(node.config.retryDelayMinutes || 15) || 15));
          const callFailed = callUsesFailedBranch(call, outcome);
          const shouldRetry = callFailed && attemptNum <= maxRetries;

          if (shouldRetry) {
            attemptsMap[node.id] = attemptNum + 1;
            run.context = {
              ...prevCtx,
              outcome,
              callId: run.callId,
              callAttemptsByNode: attemptsMap,
              ...(callSummary ? { callSummary } : {}),
            };
            run.callId = "";
            run.waitKind = "call_retry";
            run.status = "waiting";
            run.dueAt = new Date(Date.now() + retryDelayMin * 60_000);
            run.steps.push(step(node, `Attempt ${attemptNum}/${maxRetries + 1} (${call?.status ?? outcome}) — retry scheduled in ${retryDelayMin} min`, "waiting"));
            run.leaseUntil = null;
            await run.save();
            continue;
          }

          run.context = {
            ...prevCtx,
            outcome,
            callId: run.callId,
            callAttemptsByNode: attemptsMap,
            ...(callSummary ? { callSummary } : {}),
          };
          run.steps.push(step(node, `Call ${call?.status ?? "unavailable"} (attempt ${attemptNum}/${maxRetries + 1}); outcome: ${outcome}`, callFailed ? "failed" : "completed"));
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
          const waitMode = node.config.waitMode || "duration";
          const mins = Math.max(1, Number(node.config.minutes || 60));
          const ctx = (run.context as Record<string, unknown>) || {};
          if (waitMode === "whatsapp_reply") {
            run.steps.push(step(node, `Waiting up to ${mins} min for customer WhatsApp reply`, "waiting"));
            run.status = "waiting"; run.waitKind = "whatsapp_reply";
            run.context = { ...ctx, waitReplyMatched: false, waitStartedAt: new Date().toISOString() };
            run.dueAt = new Date(Date.now() + mins * 60_000);
          } else if (waitMode === "payment_paid") {
            if (ctx.paymentPaid === true) {
              run.steps.push(step(node, "Razorpay payment already confirmed — continuing immediately"));
              run.currentNodeId = edgeTarget(graph, node.id, "default");
            } else {
              run.steps.push(step(node, `Waiting up to ${mins} min for Razorpay payment`, "waiting"));
              run.status = "waiting"; run.waitKind = "payment_paid";
              run.context = { ...ctx, waitStartedAt: new Date().toISOString() };
              run.dueAt = new Date(Date.now() + mins * 60_000);
            }
          } else if (waitMode === "case_resolved") {
            let currentCaseStatus = String(ctx.caseStatus || "").toLowerCase();
            if (currentCaseStatus !== "resolved" && (ctx.caseId || ctx.caseNumber)) {
              const liveCase = await WhatsAppSupportCaseModel.findOne({
                ownerId: run.ownerId,
                ...(ctx.caseId ? { _id: ctx.caseId } : { caseNumber: String(ctx.caseNumber) }),
              }).lean().catch(() => null);
              if (liveCase?.status) currentCaseStatus = String(liveCase.status).toLowerCase();
            }
            if (currentCaseStatus === "resolved" || ctx.caseResolved === true) {
              run.steps.push(step(node, `Support case ${String(ctx.caseNumber || "").trim() || ""} already resolved — continuing immediately`));
              run.context = { ...ctx, caseStatus: "resolved", caseResolved: true };
              run.currentNodeId = edgeTarget(graph, node.id, "default");
            } else {
              run.steps.push(step(node, `Waiting up to ${mins} min for Support Case resolution (SLA timer)`, "waiting"));
              run.status = "waiting"; run.waitKind = "case_resolved";
              run.context = { ...ctx, waitStartedAt: new Date().toISOString() };
              run.dueAt = new Date(Date.now() + mins * 60_000);
            }
          } else {
            run.steps.push(step(node, `Waiting ${mins} minutes`, "waiting"));
            run.status = "waiting"; run.waitKind = "delay";
            run.dueAt = new Date(Date.now() + mins * 60_000);
          }
          if (run.status === "waiting") {
            run.leaseUntil = null; await run.save(); continue;
          }
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
            } else if (conditionType === "payment_paid") {
              matches = context.paymentPaid === true;
              detailLabel = "Razorpay payment completed";
            } else if (conditionType === "case_status") {
              let currentCaseStatus = String(context.caseStatus ?? "").toLowerCase();
              if (context.caseId || context.caseNumber) {
                const liveCase = await WhatsAppSupportCaseModel.findOne({
                  ownerId: run.ownerId,
                  ...(context.caseId ? { _id: context.caseId } : { caseNumber: String(context.caseNumber) }),
                }).lean().catch(() => null);
                if (liveCase?.status) {
                  currentCaseStatus = String(liveCase.status).toLowerCase();
                  run.context = { ...context, caseStatus: currentCaseStatus, caseResolved: currentCaseStatus === "resolved" };
                }
              }
              matches = currentCaseStatus === targetVal;
              detailLabel = `Support case status (${currentCaseStatus || "none"}) == "${targetVal}"`;
            } else if (conditionType === "case_priority") {
              const currentPriority = String(context.casePriority ?? "").toLowerCase();
              matches = currentPriority === targetVal;
              detailLabel = `Support case priority (${currentPriority || "none"}) == "${targetVal}"`;
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
            const decisionType = node.config.decisionType || "agentic";
            const evaluation = await evaluateAgenticDecision({
              decisionType,
              agentGoal: node.config.agentGoal,
              callOutcome,
              callSummary: String(context.callSummary ?? ""),
              whatsappReply,
              whatsappConversation: node.config.useConversationContext === "true"
                ? String(context.whatsappConversation ?? "")
                : "",
              requiredAction: node.config.requiredAction,
              paymentPaid: context.paymentPaid === true,
              crmStage: String(context.crmStage ?? ""),
              tags: Array.isArray(context.tags) ? (context.tags as string[]) : [],
            });
            handle = evaluation.decision;
            run.steps.push(step(node, `${evaluation.usedLlm ? "AI LLM Router" : "AI Router"} → ${handle} (${evaluation.reason})`));
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
          const dialDigits = cleanPhoneNumber(run.contactPhone);
          const dialDestination = run.contactPhone.trim().startsWith("+")
            ? run.contactPhone.trim()
            : dialDigits
              ? `+${dialDigits}`
              : run.contactPhone.trim();
          if (await ContactSuppressionModel.exists({ ownerId: run.ownerId, phone: { $in: [dialDestination, dialDigits, run.contactPhone] } })) {
            throw new Error("Contact is on the do-not-call list.");
          }
          const timezone = node.config.timezone || "Asia/Kolkata";
          const local = campaignLocalClock(timezone);
          if (!isInsideCallWindow(node.config.windowStart || "09:00", node.config.windowEnd || "18:00", local.time)) {
            run.status = "waiting"; run.waitKind = "window"; run.dueAt = new Date(Date.now() + 5 * 60_000);
            run.leaseUntil = null; await run.save(); continue;
          }
          await assertCallCapacity(run.ownerId);
          let admission: Awaited<ReturnType<typeof acquirePhoneNumberCallAdmission>>;
          try {
            admission = await acquirePhoneNumberCallAdmission(run.ownerId, phone.id);
          } catch (admErr) {
            const msg = admErr instanceof Error ? admErr.message : "";
            const statusCode = admErr && typeof admErr === "object" && "statusCode" in admErr ? Number((admErr as { statusCode?: number }).statusCode) : 0;
            if (statusCode === 429 || /concurrent|capacity|busy|limit|admission/i.test(msg)) {
              run.status = "waiting"; run.waitKind = "window"; run.dueAt = new Date(Date.now() + 35_000);
              run.actionType = ""; run.actionNodeId = ""; run.leaseUntil = null;
              await run.save(); continue;
            }
            throw admErr;
          }
          run.actionType = "call"; run.actionNodeId = node.id;
          await run.save();
          try {
            const result = await startOutboundCall(agent, run.ownerId, dialDestination, phone.number, {
              phoneNumberId: phone.id, callAdmission: admission, telephonyProvider: phone.provider,
              outboundTrunkId: phone.outboundTrunkId,
              metadata: { automationId: String(run.automationId), automationRunId: run.id, automationVersion: run.version, ContactName: run.contactName || "Customer" },
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
              .replace(/\{\{crmStage\}\}/gi, String(runCtx.crmStage || "Qualified"))
              .replace(/\{\{caseNumber\}\}/gi, String(runCtx.caseNumber || ""))
              .replace(/\{\{caseStatus\}\}/gi, String(runCtx.caseStatus || ""))
              .replace(/\{\{casePriority\}\}/gi, String(runCtx.casePriority || ""))
              .replace(/\{\{caseSubject\}\}/gi, String(runCtx.caseSubject || ""));

          const localTemplate = node.config.templateName
            ? await WhatsAppTemplateModel.findOne({ ownerId: run.ownerId, name: node.config.templateName }).catch(() => null)
            : null;

          let renderedText = "";
          if (node.config.messageMode === "ai_dynamic") {
            const promptHint = node.config.aiPrompt || "Follow up warmly with the customer regarding their inquiry and next steps.";
            const fallbackText = replaceVars(
              `Hi ${run.contactName || "there"}! ${promptHint}\n\nReply anytime if you'd like to schedule or speak with our specialist.`,
            );
            const aiMsg = await generateDynamicWhatsAppMessage({
              promptHint: replaceVars(promptHint),
              contactName: run.contactName || "Customer",
              outcome: String(runCtx.outcome || ""),
              callSummary: String(runCtx.callSummary || ""),
              whatsappReply: String(runCtx.whatsappReply || ""),
              paymentLink: String(runCtx.paymentLink || ""),
              calendlyLink: String(runCtx.calendlyLink || runCtx.calendarHtmlLink || ""),
              calendarTime: String(runCtx.appointmentSlot || ""),
              crmStage: String(runCtx.crmStage || ""),
              fallbackText,
            });
            renderedText = aiMsg.text;
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

          let metaMessageId = "";
          let sendWarning = "";
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
              sendWarning = err instanceof Error ? err.message : "Meta WhatsApp send failed";
              console.warn("Workflow WhatsApp live send failed:", err);
            }
          } else {
            sendWarning = "No connected WhatsApp Business account in workspace";
          }

          const deliveredLive = Boolean(metaMessageId);
          const recordedMsgId = metaMessageId || `unsent_${Date.now()}`;

          // Also record in WhatsApp Live Chat conversation so staff can see it
          const cleanPhone = cleanPhoneNumber(run.contactPhone);
          const conv = await upsertAutomationWhatsAppConversation({
            ownerId: run.ownerId,
            contactPhone: cleanPhone,
            contactName: run.contactName || "Customer",
            lastMessageText: renderedText,
            phoneNumberId: integration?.accountId,
            displayPhoneNumber: String((integration?.metadata as Record<string, unknown> | undefined)?.displayPhoneNumber || ""),
            tags: ["Workflow"],
          });
          await WhatsAppMessageModel.create({
            ownerId: run.ownerId,
            conversationId: conv._id,
            direction: "outbound",
            senderPhone: String((integration?.metadata as Record<string, unknown> | undefined)?.displayPhoneNumber || "Workflow AI"),
            recipientPhone: cleanPhone,
            type: node.config.messageMode === "ai_dynamic" ? "text" : "template",
            content: renderedText,
            status: deliveredLive ? "delivered" : "failed",
            metaMessageId: recordedMsgId,
          });

          run.whatsappMessageId = recordedMsgId;
          run.whatsappSentAt = new Date();
          run.context = {
            ...(run.context as Record<string, unknown>),
            whatsappStatus: deliveredLive ? "delivered" : "failed",
            whatsappMessageId: recordedMsgId,
            ...(sendWarning ? { whatsappError: sendWarning } : {}),
          };
          run.steps.push(
            step(
              node,
              deliveredLive
                ? `WhatsApp sent (${node.config.templateName || "AI Message"}): ${recordedMsgId}`
                : `WhatsApp not sent to Meta (${sendWarning}) — logged in inbox`,
              deliveredLive ? "completed" : "failed",
            ),
          );
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
            const conv = await upsertAutomationWhatsAppConversation({
              ownerId: run.ownerId,
              contactPhone: cleanPhone,
              contactName: run.contactName || "Customer",
              lastMessageText: payText,
              phoneNumberId: waConn?.accountId,
              displayPhoneNumber: String((waConn?.metadata as Record<string, unknown> | undefined)?.displayPhoneNumber || ""),
              tags: ["Payment"],
            });
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
        } else if (node.type === "case") {
          const runCtx = (run.context as Record<string, unknown>) || {};
          const replaceCaseVars = (raw: string) =>
            raw
              .replace(/\{\{name\}\}/gi, run.contactName || "Customer")
              .replace(/\{\{phone\}\}/gi, run.contactPhone)
              .replace(/\{\{outcome\}\}/gi, String(runCtx.outcome || ""))
              .replace(/\{\{summary\}\}/gi, String(runCtx.callSummary || runCtx.whatsappReply || "Customer inquiry"))
              .replace(/\{\{whatsappReply\}\}/gi, String(runCtx.whatsappReply || ""))
              .replace(/\{\{crmStage\}\}/gi, String(runCtx.crmStage || ""));

          const cleanPhone = cleanPhoneNumber(run.contactPhone);
          const existingCount = await WhatsAppSupportCaseModel.countDocuments({ ownerId: run.ownerId });
          const caseNumber = `CASE-${1001 + existingCount}`;
          const subject = replaceCaseVars(node.config.subject || "Support request for {{name}}").trim().slice(0, 200) || "Customer Support Request";
          const category = (node.config.category || "Support").trim().slice(0, 80);
          const priority = (["low", "medium", "high", "urgent"].includes(node.config.priority || "")
            ? node.config.priority
            : "medium") as "low" | "medium" | "high" | "urgent";
          const notes = replaceCaseVars(node.config.notes || String(runCtx.callSummary || runCtx.whatsappReply || "")).trim().slice(0, 1000);

          const existingConv = await findWhatsAppConversationForLine(run.ownerId, cleanPhone).catch(() => null);
          const supportCase = await WhatsAppSupportCaseModel.create({
            ownerId: run.ownerId,
            caseNumber,
            ...(existingConv?._id ? { conversationId: existingConv._id } : {}),
            contactPhone: cleanPhone,
            contactName: (run.contactName || "Customer").trim(),
            subject,
            category,
            priority,
            status: "open",
            notes,
          });

          await WhatsAppContactModel.findOneAndUpdate(
            { ownerId: run.ownerId, phoneNumber: cleanPhone },
            {
              $set: {
                name: run.contactName || "Customer",
                lastContactedAt: new Date(),
                "customAttributes.latestCaseNumber": caseNumber,
                "customAttributes.crmStage": "Case Opened",
              },
              $addToSet: { tags: { $each: [caseNumber, "Support-Case"] } },
            },
            { upsert: true },
          );

          if (existingConv?._id) {
            await WhatsAppConversationModel.updateOne(
              { _id: existingConv._id, ownerId: run.ownerId },
              { $addToSet: { tags: caseNumber } },
            );
          }

          void syncLeadToConnectedCrms(run.ownerId, {
            contactName: run.contactName || "Customer",
            contactPhone: cleanPhone,
            stage: "Case Opened",
            tag: caseNumber,
            outcome: category,
            summary: `[${caseNumber}] ${subject}`,
          }).catch(() => undefined);

          void notifyConnectedSlack(
            run.ownerId,
            `🎫 *Support Case ${caseNumber} Opened* (Workflow) for ${run.contactName || run.contactPhone}\n• *Subject:* ${subject}\n• *Category:* ${category} | *Priority:* ${priority}`,
          ).catch(() => undefined);

          let waNotified = false;
          if (node.config.notifyCustomer !== "false") {
            const integrations = await ProviderIntegrationModel.find({
              ownerId: run.ownerId,
              provider: "whatsapp",
              status: "connected",
            }).select("+secretEncrypted").sort({ createdAt: 1 });
            const waConn =
              integrations.find((i) => Boolean((i.metadata as Record<string, unknown> | undefined)?.isPrimary)) ||
              integrations[0];
            const noticeText = `🎫 Support Case Created: *${caseNumber}*\nSubject: ${subject}\nPriority: ${priority.toUpperCase()} — Reply "${caseNumber}" anytime to check status.`;
            let metaMsgId = "";
            if (waConn?.secretEncrypted) {
              try {
                const sent = await sendWhatsAppMessage(waConn.accountId, decryptSecret(waConn.secretEncrypted), run.contactPhone, {
                  type: "text",
                  text: noticeText,
                });
                metaMsgId = sent.messageId;
                waNotified = true;
              } catch {
                /* Non-fatal if WhatsApp session closed */
              }
            }
            const conv = await upsertAutomationWhatsAppConversation({
              ownerId: run.ownerId,
              contactPhone: cleanPhone,
              contactName: run.contactName || "Customer",
              lastMessageText: noticeText,
              phoneNumberId: waConn?.accountId,
              displayPhoneNumber: String((waConn?.metadata as Record<string, unknown> | undefined)?.displayPhoneNumber || ""),
              tags: ["Support-Case", caseNumber],
            });
            await WhatsAppMessageModel.create({
              ownerId: run.ownerId,
              conversationId: conv._id,
              direction: "outbound",
              senderPhone: String((waConn?.metadata as Record<string, unknown> | undefined)?.displayPhoneNumber || "Support Desk"),
              recipientPhone: cleanPhone,
              type: "text",
              content: noticeText,
              status: metaMsgId ? "delivered" : "failed",
              metaMessageId: metaMsgId || `case_${caseNumber}`,
            });
          }

          const existingTags = Array.isArray(runCtx.tags) ? (runCtx.tags as string[]) : [];
          run.context = {
            ...runCtx,
            caseId: String(supportCase._id),
            caseNumber,
            caseStatus: "open",
            casePriority: priority,
            caseCategory: category,
            caseSubject: subject,
            caseResolved: false,
            tags: Array.from(new Set([...existingTags, caseNumber, "Support-Case"])),
          };
          run.steps.push(step(node, `Support Case ${caseNumber} opened (${priority} · ${category})${waNotified ? " & customer notified on WhatsApp" : ""}`));
          run.currentNodeId = edgeTarget(graph, node.id, "default");
        } else if (node.type === "sms") {
          const runCtx = (run.context as Record<string, unknown>) || {};
          const msgText = (node.config.messageText || "Hi {{name}}, thank you for connecting with us! We will follow up shortly.")
            .replace(/\{\{name\}\}/gi, run.contactName || "Customer")
            .replace(/\{\{phone\}\}/gi, run.contactPhone)
            .replace(/\{\{outcome\}\}/gi, String(runCtx.outcome || "Completed"))
            .replace(/\{\{paymentLink\}\}/gi, String(runCtx.paymentLink || ""))
            .replace(/\{\{calendlyLink\}\}/gi, String(runCtx.calendlyLink || ""))
            .replace(/\{\{caseNumber\}\}/gi, String(runCtx.caseNumber || ""))
            .replace(/\{\{caseStatus\}\}/gi, String(runCtx.caseStatus || ""))
            .replace(/\{\{casePriority\}\}/gi, String(runCtx.casePriority || ""))
            .replace(/\{\{caseSubject\}\}/gi, String(runCtx.caseSubject || ""));
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

export type CaseAutomationPayload = {
  _id: unknown;
  caseNumber: string;
  contactPhone: string;
  contactName?: string;
  subject: string;
  category?: string;
  priority?: string;
  status: string;
};

export async function triggerCaseAutomations(input: {
  ownerId: string;
  event: "case_created" | "case_resolved";
  supportCase: CaseAutomationPayload;
}) {
  const cleanPhone = cleanPhoneNumber(input.supportCase.contactPhone);
  if (!cleanPhone) return;
  const e164Phone = `+${cleanPhone}`;
  const phoneVariants = [cleanPhone, e164Phone];

  const suppressed = await ContactSuppressionModel.exists({
    ownerId: input.ownerId,
    phoneNumber: { $in: phoneVariants },
  });
  if (suppressed) return;

  const liveAutomations = await AutomationModel.find({
    ownerId: input.ownerId,
    status: "live",
    published: { $ne: null },
  });

  for (const flowDoc of liveAutomations) {
    const graph = flowDoc.published as { nodes?: Array<{ id: string; type: string; config: Record<string, string> }> };
    const trigger = graph?.nodes?.find((n) => n.type === "trigger");
    if (!trigger || trigger.config.event !== input.event) continue;

    const filterPriority = (trigger.config.priority || "").trim().toLowerCase();
    const casePriority = String(input.supportCase.priority || "medium").toLowerCase();
    if (filterPriority && filterPriority !== "all" && filterPriority !== casePriority) continue;

    const keyword = (trigger.config.keyword || "").trim().toLowerCase();
    const haystack = `${input.supportCase.subject} ${input.supportCase.category || ""} ${input.supportCase.caseNumber}`.toLowerCase();
    if (keyword && !haystack.includes(keyword)) continue;

    const existingActive = await AutomationRunModel.exists({
      ownerId: input.ownerId,
      automationId: flowDoc._id,
      contactPhone: { $in: phoneVariants },
      status: { $in: ["queued", "running", "waiting"] },
    });
    if (existingActive) continue;

    const eventId = `${input.event}:${input.supportCase.caseNumber}:${Date.now()}`;
    await AutomationRunModel.create({
      ownerId: input.ownerId,
      automationId: flowDoc._id,
      version: flowDoc.publishedVersion,
      graph,
      eventId,
      contactName: input.supportCase.contactName || "Customer",
      contactPhone: e164Phone,
      status: "queued",
      currentNodeId: trigger.id,
      context: {
        consentConfirmed: true,
        source: input.event,
        caseId: String(input.supportCase._id),
        caseNumber: input.supportCase.caseNumber,
        caseStatus: input.supportCase.status,
        casePriority,
        caseCategory: input.supportCase.category || "Support",
        caseSubject: input.supportCase.subject,
        caseResolved: input.supportCase.status === "resolved",
        lastMessageText: input.supportCase.subject,
      },
    });
    void processAutomationRuns().catch(() => undefined);
  }
}

export async function handleCaseStatusAutomationUpdate(input: {
  ownerId: string;
  supportCase: CaseAutomationPayload;
}) {
  const cleanPhone = cleanPhoneNumber(input.supportCase.contactPhone);
  const phoneVariants = cleanPhone ? [cleanPhone, `+${cleanPhone}`] : [];
  const matchClauses: Array<Record<string, unknown>> = [
    { "context.caseId": String(input.supportCase._id) },
    { "context.caseNumber": input.supportCase.caseNumber },
  ];
  if (phoneVariants.length) {
    matchClauses.push({ contactPhone: { $in: phoneVariants } });
  }

  const isResolved = input.supportCase.status === "resolved";
  const caseContextUpdate = {
    "context.caseId": String(input.supportCase._id),
    "context.caseNumber": input.supportCase.caseNumber,
    "context.caseStatus": input.supportCase.status,
    "context.casePriority": String(input.supportCase.priority || "medium").toLowerCase(),
    "context.caseCategory": input.supportCase.category || "Support",
    "context.caseSubject": input.supportCase.subject,
    "context.caseResolved": isResolved,
  };

  if (isResolved) {
    const woken = await AutomationRunModel.updateMany(
      {
        ownerId: input.ownerId,
        status: "waiting",
        waitKind: "case_resolved",
        $or: matchClauses,
      },
      {
        $set: {
          ...caseContextUpdate,
          dueAt: new Date(),
        },
      },
    );
    await AutomationRunModel.updateMany(
      {
        ownerId: input.ownerId,
        status: { $in: ["queued", "waiting"] },
        waitKind: { $ne: "case_resolved" },
        $or: matchClauses,
      },
      { $set: caseContextUpdate },
    );
    if (woken.modifiedCount > 0) {
      void processAutomationRuns().catch(() => undefined);
    }
    await triggerCaseAutomations({
      ownerId: input.ownerId,
      event: "case_resolved",
      supportCase: input.supportCase,
    });
  } else {
    await AutomationRunModel.updateMany(
      {
        ownerId: input.ownerId,
        status: { $in: ["queued", "waiting"] },
        $or: matchClauses,
      },
      { $set: caseContextUpdate },
    );
  }
}

export type BulkContactInput = { name?: string; phone: string };

/**
 * Extracts phone numbers (and optional names on `Name, +919876543210` lines)
 * from raw pasted text, WhatsApp messages, or CSV rows.
 */
export function parseBulkContactsText(rawText: string): BulkContactInput[] {
  const results: BulkContactInput[] = [];
  const seen = new Set<string>();
  const lines = String(rawText || "").split(/\r?\n/);

  const pushPhone = (rawPhone: string, name = "") => {
    const cleaned = cleanPhoneNumber(rawPhone);
    if (!cleaned || cleaned.length < 8 || cleaned.length > 15) return;
    const e164 = `+${cleaned}`;
    if (!/^\+[1-9]\d{7,14}$/.test(e164)) return;
    if (seen.has(e164)) return;
    seen.add(e164);
    results.push({ name: name.trim().slice(0, 120), phone: e164 });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Check if the line looks like "Name, phone" or "Name - phone"
    const csvParts = trimmed.split(/[,;\t|]+/).map((p) => p.trim()).filter(Boolean);
    if (csvParts.length >= 2) {
      const phoneIdx = csvParts.findIndex((p) => (p.replace(/\D/g, "").length >= 8 && p.replace(/\D/g, "").length <= 15));
      if (phoneIdx >= 0) {
        const namePart = csvParts[phoneIdx === 0 ? 1 : 0] ?? "";
        const looksLikeName = namePart && namePart.replace(/\D/g, "").length < 7;
        pushPhone(csvParts[phoneIdx], looksLikeName ? namePart : "");
        // Also pick up any additional phones on the same comma-separated line
        for (let i = 0; i < csvParts.length; i += 1) {
          if (i !== phoneIdx && csvParts[i].replace(/\D/g, "").length >= 8) {
            pushPhone(csvParts[i], "");
          }
        }
        continue;
      }
    }
    // Otherwise extract all phone-like tokens from the line
    const matches = trimmed.match(/\+?\d[\d\s\-().]{7,18}\d/g) || [];
    for (const m of matches) {
      pushPhone(m, "");
    }
  }
  return results;
}

export async function enqueueBulkAutomationRuns(input: {
  ownerId: string;
  automationId: string;
  contacts: BulkContactInput[];
  source: "dashboard_bulk" | "whatsapp_admin_dispatch";
  requestedBy?: string;
  maxBatch?: number;
}) {
  const flow = await AutomationModel.findOne({
    _id: input.automationId,
    ownerId: input.ownerId,
    status: "live",
    published: { $ne: null },
  });
  if (!flow || !flow.published) {
    throw new Error("Target workflow must be published and live before bulk launching.");
  }

  const graph = normalizeAutomationGraph(flow.published as AutomationGraph);
  const trigger = graph.nodes.find((node) => node.type === "trigger");
  if (!trigger) throw new Error("This workflow has no start trigger.");

  const activeStatuses = ["queued", "running", "waiting"];
  const activeCount = await AutomationRunModel.countDocuments({
    ownerId: input.ownerId,
    status: { $in: activeStatuses },
  });
  const maxActiveWorkspace = 2000;
  const availableSlots = Math.max(0, maxActiveWorkspace - activeCount);
  const maxBatch = Math.min(500, Math.max(1, input.maxBatch ?? 500), availableSlots);

  let skippedInvalid = 0;
  let skippedDuplicates = 0;
  let skippedDnc = 0;
  let capped = 0;

  // Normalize & dedupe input list
  const normalized: Array<{ name: string; phone: string; digits: string }> = [];
  const seen = new Set<string>();
  for (const c of input.contacts) {
    const digits = cleanPhoneNumber(c.phone);
    const e164 = digits ? `+${digits}` : "";
    if (!/^\+[1-9]\d{7,14}$/.test(e164)) {
      skippedInvalid += 1;
      continue;
    }
    if (seen.has(e164)) {
      skippedDuplicates += 1;
      continue;
    }
    seen.add(e164);
    normalized.push({ name: (c.name || "").trim().slice(0, 120), phone: e164, digits });
  }

  if (normalized.length === 0) {
    return {
      automationId: String(flow._id),
      automationName: flow.name,
      queued: 0,
      skippedInvalid,
      skippedDuplicates,
      skippedDnc,
      capped,
    };
  }

  const allPhoneVariants = normalized.flatMap((c) => [c.phone, c.digits]);
  const [suppressedDocs, activeDocs] = await Promise.all([
    ContactSuppressionModel.find({
      ownerId: input.ownerId,
      phone: { $in: allPhoneVariants },
    }).select("phone").lean(),
    AutomationRunModel.find({
      ownerId: input.ownerId,
      automationId: flow._id,
      contactPhone: { $in: allPhoneVariants },
      status: { $in: activeStatuses },
    }).select("contactPhone").lean(),
  ]);

  const suppressedSet = new Set(suppressedDocs.map((d) => cleanPhoneNumber(String(d.phone || ""))));
  const activeSet = new Set(activeDocs.map((d) => cleanPhoneNumber(String(d.contactPhone || ""))));

  const batchTag = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const docsToInsert: Array<Record<string, unknown>> = [];

  for (let i = 0; i < normalized.length; i += 1) {
    const item = normalized[i];
    if (suppressedSet.has(item.digits)) {
      skippedDnc += 1;
      continue;
    }
    if (activeSet.has(item.digits)) {
      skippedDuplicates += 1;
      continue;
    }
    if (docsToInsert.length >= maxBatch) {
      capped += 1;
      continue;
    }
    docsToInsert.push({
      ownerId: input.ownerId,
      automationId: flow._id,
      version: flow.publishedVersion,
      graph: flow.published,
      eventId: `${input.source}:${batchTag}:${i}:${item.digits}`,
      contactName: item.name,
      contactPhone: item.phone,
      currentNodeId: trigger.id,
      status: "queued",
      context: {
        consentConfirmed: true,
        source: input.source,
        batchId: batchTag,
        ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
      },
    });
  }

  if (docsToInsert.length > 0) {
    await AutomationRunModel.insertMany(docsToInsert, { ordered: false }).catch(() => undefined);
    void processAutomationRuns(50).catch((err) => console.error("Bulk automation start failed:", err));
  }

  return {
    automationId: String(flow._id),
    automationName: flow.name,
    batchId: batchTag,
    queued: docsToInsert.length,
    skippedInvalid,
    skippedDuplicates,
    skippedDnc,
    capped,
  };
}
