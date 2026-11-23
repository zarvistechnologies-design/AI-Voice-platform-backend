import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { isValidObjectId, startSession } from "mongoose";
import { z } from "zod";
import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WhiteLabelEntitledRequest } from "../middleware/whiteLabelEntitlements.js";
import { AutomationModel, AutomationRunModel, AutomationVersionModel } from "../models/Automation.js";
import { ContactSuppressionModel } from "../models/ContactSuppression.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { WhatsAppContactModel, WhatsAppTemplateModel } from "../models/WhatsAppEntities.js";
import { HttpError } from "../utils/httpError.js";
import { findOwnedAutomation, graphSchema, normalizeAutomationGraph, parseDraft, validateAutomation } from "../services/automationDefinitionService.js";
import { enqueueBulkAutomationRuns, parseBulkContactsText, processAutomationRuns } from "../services/automationRuntimeService.js";
import { simulateAutomation } from "../services/automationSimulationService.js";
import { cleanPhoneNumber } from "../services/whatsappService.js";

function ownerId(request: AuthenticatedRequest) {
  if (!request.organization || !request.user) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}
function flowId(request: AuthenticatedRequest) {
  const id = String(request.params.automationId ?? "");
  if (!isValidObjectId(id)) throw new HttpError(404, "Workflow not found.");
  return id;
}
function planFeatures(request: AuthenticatedRequest) {
  return (request as WhiteLabelEntitledRequest).whiteLabelSubscription?.features;
}

export async function listAutomations(request: AuthenticatedRequest, response: Response) {
  const flows = await AutomationModel.find({ ownerId: ownerId(request) })
    .select("name description status revision publishedVersion updatedAt createdAt")
    .sort({ updatedAt: -1 }).limit(200).lean();
  response.json({ flows });
}

export async function getAutomation(request: AuthenticatedRequest, response: Response) {
  const flow = await findOwnedAutomation(ownerId(request), flowId(request));
  response.json({ flow });
}

export async function createAutomation(request: AuthenticatedRequest, response: Response) {
  const draft = parseDraft(request.body);
  const flow = await AutomationModel.create({ ownerId: ownerId(request), name: draft.name, description: draft.description, draft: draft.graph, createdBy: String(request.user?.id ?? "") });
  response.status(201).json({ flow });
}

export async function saveAutomation(request: AuthenticatedRequest, response: Response) {
  const draft = parseDraft(request.body);
  if (!draft.revision) throw new HttpError(400, "Workflow revision is required.");
  const flow = await AutomationModel.findOneAndUpdate(
    { _id: flowId(request), ownerId: ownerId(request), revision: draft.revision },
    { $set: { name: draft.name, description: draft.description, draft: draft.graph }, $inc: { revision: 1 } },
    { new: true, runValidators: true },
  );
  if (!flow) throw new HttpError(409, "This workflow changed elsewhere. Reload it before saving.");
  response.json({ flow });
}

export async function deleteAutomation(request: AuthenticatedRequest, response: Response) {
  const owner = ownerId(request);
  const id = flowId(request);
  if (await AutomationRunModel.exists({ ownerId: owner, automationId: id, status: { $in: ["queued", "running", "waiting"] } })) {
    throw new HttpError(409, "Pause this workflow and let active runs finish before deleting it.");
  }
  const session = await startSession();
  try {
    await session.withTransaction(async () => {
      const flow = await AutomationModel.findOneAndDelete({ _id: id, ownerId: owner }, { session });
      if (!flow) throw new HttpError(404, "Workflow not found.");
      await AutomationVersionModel.deleteMany({ ownerId: owner, automationId: id }, { session });
      await AutomationRunModel.deleteMany({ ownerId: owner, automationId: id }, { session });
    });
  } finally { await session.endSession(); }
  response.status(204).send();
}

export async function checkAutomation(request: AuthenticatedRequest, response: Response) {
  const flow = await findOwnedAutomation(ownerId(request), flowId(request));
  const graph = request.body && typeof request.body === "object" && "graph" in request.body
    ? graphSchema.safeParse(request.body.graph) : null;
  if (graph && !graph.success) throw new HttpError(400, graph.error.issues[0]?.message ?? "Invalid graph.");
  const candidate = graph?.data ?? flow.draft;
  response.json({ issues: await validateAutomation(ownerId(request), candidate as Parameters<typeof validateAutomation>[1], planFeatures(request)) });
}

export async function testAutomation(request: AuthenticatedRequest, response: Response) {
  const flow = await findOwnedAutomation(ownerId(request), flowId(request));
  const outcome = z.enum(["qualified", "follow_up", "not_interested", "unknown", "missed"]).catch("qualified").parse(request.body?.outcome);
  response.json({ mode: "dry_run", steps: simulateAutomation(flow.draft as Parameters<typeof simulateAutomation>[0], outcome) });
}

export async function publishAutomation(request: AuthenticatedRequest, response: Response) {
  const flow = await findOwnedAutomation(ownerId(request), flowId(request));
  const issues = await validateAutomation(ownerId(request), flow.draft as Parameters<typeof validateAutomation>[1], planFeatures(request), true);
  if (issues.length) { response.status(422).json({ message: "Resolve workflow checks before publishing.", issues }); return; }
  const session = await startSession();
  let updated: typeof flow | null = null;
  try {
    await session.withTransaction(async () => {
      updated = await AutomationModel.findOneAndUpdate(
        { _id: flow._id, ownerId: ownerId(request), revision: flow.revision, publishedVersion: flow.publishedVersion },
        { $set: { status: "live", published: flow.draft, publishedAt: new Date(), publishedBy: String(request.user?.id ?? ""), triggerCursor: "" }, $inc: { publishedVersion: 1 } },
        { new: true, session },
      );
      if (!updated) throw new HttpError(409, "Workflow changed while publishing. Reload and try again.");
      await AutomationVersionModel.create([{ ownerId: ownerId(request), automationId: flow._id, version: flow.publishedVersion + 1, graph: flow.draft, name: flow.name, publishedBy: String(request.user?.id ?? "") }], { session });
    });
  } finally { await session.endSession(); }
  response.json({ flow: updated });
}

export async function listAutomationVersions(request: AuthenticatedRequest, response: Response) {
  await findOwnedAutomation(ownerId(request), flowId(request));
  const versions = await AutomationVersionModel.find({ ownerId: ownerId(request), automationId: flowId(request) })
    .select("version name publishedBy createdAt").sort({ version: -1 }).limit(30).lean();
  response.json({ versions });
}

export async function restoreAutomationVersion(request: AuthenticatedRequest, response: Response) {
  const flow = await findOwnedAutomation(ownerId(request), flowId(request));
  const versionNumber = Number(request.params.version);
  if (!Number.isInteger(versionNumber) || versionNumber < 1) throw new HttpError(400, "Invalid version.");
  const version = await AutomationVersionModel.findOne({ ownerId: ownerId(request), automationId: flow._id, version: versionNumber });
  if (!version) throw new HttpError(404, "Version not found.");
  const restoredGraph = normalizeAutomationGraph(version.graph as Parameters<typeof validateAutomation>[1]);
  const issues = await validateAutomation(ownerId(request), restoredGraph, planFeatures(request), true);
  if (issues.length) { response.status(422).json({ message: "This version needs setup before it can be restored.", issues }); return; }
  const session = await startSession();
  let updated: typeof flow | null = null;
  try {
    await session.withTransaction(async () => {
      updated = await AutomationModel.findOneAndUpdate(
        { _id: flow._id, ownerId: ownerId(request), publishedVersion: flow.publishedVersion },
        { $set: { status: "live", published: restoredGraph, draft: restoredGraph, publishedAt: new Date(), publishedBy: String(request.user?.id ?? ""), triggerCursor: "" }, $inc: { publishedVersion: 1, revision: 1 } },
        { new: true, session },
      );
      if (!updated) throw new HttpError(409, "Workflow changed while restoring. Reload and try again.");
      await AutomationVersionModel.create([{ ownerId: ownerId(request), automationId: flow._id, version: flow.publishedVersion + 1, graph: restoredGraph, name: flow.name, publishedBy: String(request.user?.id ?? "") }], { session });
    });
  } finally { await session.endSession(); }
  response.json({ flow: updated });
}

export async function setAutomationStatus(request: AuthenticatedRequest, response: Response) {
  const parsed = z.enum(["live", "paused"]).safeParse(request.body?.status);
  if (!parsed.success) throw new HttpError(400, "Status must be live or paused.");
  const status = parsed.data;
  const flow = await findOwnedAutomation(ownerId(request), flowId(request));
  if (!flow.published) throw new HttpError(409, "Publish a workflow before changing its status.");
  flow.status = status; await flow.save();
  response.json({ flow });
}

export async function listAutomationRuns(request: AuthenticatedRequest, response: Response) {
  await findOwnedAutomation(ownerId(request), flowId(request));
  const runs = await AutomationRunModel.find({ ownerId: ownerId(request), automationId: flowId(request) })
    .select("version eventId contactName contactPhone status currentNodeId steps error createdAt updatedAt finishedAt")
    .sort({ createdAt: -1 }).limit(100).lean();
  response.json({ runs });
}

export async function getAutomationRun(request: AuthenticatedRequest, response: Response) {
  const owner = ownerId(request);
  const automationId = flowId(request);
  await findOwnedAutomation(owner, automationId);
  const runId = String(request.params.runId ?? "");
  if (!isValidObjectId(runId)) throw new HttpError(404, "Workflow run not found.");
  const run = await AutomationRunModel.findOne({ _id: runId, ownerId: owner, automationId })
    .select("version eventId contactName contactPhone status currentNodeId steps error createdAt updatedAt finishedAt dueAt waitKind");
  if (!run) throw new HttpError(404, "Workflow run not found.");
  response.json({ run });
}

export async function startAutomationRun(request: AuthenticatedRequest, response: Response) {
  const flow = await findOwnedAutomation(ownerId(request), flowId(request));
  if (flow.status !== "live" || !flow.published) throw new HttpError(409, "Publish and activate this workflow before starting a run.");
  const input = z.object({
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/, "Use an E.164 phone number, for example +919876543210."),
    name: z.string().trim().max(120).default(""),
    eventId: z.string().trim().max(160).optional(),
    consentConfirmed: z.literal(true),
  }).safeParse(request.body);
  if (!input.success) throw new HttpError(400, input.error.issues[0]?.message ?? "Invalid run input.");
  const graph = flow.published as Parameters<typeof simulateAutomation>[0];
  const features = planFeatures(request);
  if (features && graph.nodes.some((node) => node.type === "call") && features.outboundCalling !== true) {
    throw new HttpError(403, "Outbound calling is not included in this customer plan.");
  }
  if (features && graph.nodes.some((node) => node.type === "whatsapp") && features.integrations !== true) {
    throw new HttpError(403, "Integrations are not included in this customer plan.");
  }
  const trigger = graph.nodes.find((node) => node.type === "trigger");
  if (!trigger) throw new HttpError(409, "This workflow has no start trigger.");
  const owner = ownerId(request);
  const eventId = input.data.eventId || randomUUID();
  const existing = await AutomationRunModel.findOne({ ownerId: owner, automationId: flow._id, eventId });
  if (existing) {
    if (existing.contactPhone !== input.data.phone) throw new HttpError(409, "This event ID already belongs to another contact.");
    response.status(202).json({ run: existing }); return;
  }
  const activeStatuses = ["queued", "running", "waiting"];
  if (await AutomationRunModel.exists({ ownerId: owner, automationId: flow._id, contactPhone: input.data.phone, status: { $in: activeStatuses } })) {
    throw new HttpError(409, "This contact already has an active run in this workflow.");
  }
  if (await AutomationRunModel.countDocuments({ ownerId: owner, status: { $in: activeStatuses } }) >= 2000) {
    throw new HttpError(429, "This workspace has reached its active workflow limit. Try again when runs finish.");
  }
  let run;
  try {
    run = await AutomationRunModel.findOneAndUpdate(
      { ownerId: owner, automationId: flow._id, eventId },
      { $setOnInsert: { ownerId: owner, automationId: flow._id, version: flow.publishedVersion, graph: flow.published, eventId, contactName: input.data.name, contactPhone: input.data.phone, currentNodeId: trigger.id, status: "queued", context: { consentConfirmed: true, requestedBy: request.user?.id } } },
      { upsert: true, new: true },
    );
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
    run = await AutomationRunModel.findOne({ ownerId: owner, automationId: flow._id, eventId });
    if (!run || run.contactPhone !== input.data.phone) throw new HttpError(409, "This event ID already belongs to another contact.");
  }
  if (!run) throw new HttpError(500, "Could not create the workflow run.");
  void processAutomationRuns().catch((error) => console.error("Automation run failed to start.", error));
  response.status(202).json({ run });
}

export async function startBulkAutomationRuns(request: AuthenticatedRequest, response: Response) {
  const owner = ownerId(request);
  const flow = await findOwnedAutomation(owner, flowId(request));
  if (flow.status !== "live" || !flow.published) {
    throw new HttpError(409, "Publish and activate this workflow before starting a bulk run.");
  }
  const input = z.object({
    groupId: z.string().trim().max(80).optional(),
    rawText: z.string().max(100_000).optional(),
    contacts: z.array(z.object({
      name: z.string().trim().max(120).optional(),
      phone: z.string().trim().max(40),
    })).max(500).optional(),
    consentConfirmed: z.literal(true),
  }).safeParse(request.body);
  if (!input.success) throw new HttpError(400, input.error.issues[0]?.message ?? "Invalid bulk run input.");

  const graph = flow.published as Parameters<typeof simulateAutomation>[0];
  const features = planFeatures(request);
  if (features && graph.nodes.some((node) => node.type === "call") && features.outboundCalling !== true) {
    throw new HttpError(403, "Outbound calling is not included in this customer plan.");
  }
  if (features && graph.nodes.some((node) => node.type === "whatsapp") && features.integrations !== true) {
    throw new HttpError(403, "Integrations are not included in this customer plan.");
  }

  let contacts: Array<{ name?: string; phone: string }> = [];
  if (input.data.groupId) {
    if (!isValidObjectId(input.data.groupId)) throw new HttpError(400, "Invalid contact group.");
    const groupContacts = await WhatsAppContactModel.find({
      ownerId: owner,
      groupIds: input.data.groupId,
      status: { $ne: "unsubscribed" },
    }).select("name phoneNumber").limit(500).lean();
    contacts = groupContacts.map((c) => ({ name: c.name || "", phone: String(c.phoneNumber || "") }));
  } else if (input.data.contacts && input.data.contacts.length > 0) {
    contacts = input.data.contacts;
  } else if (input.data.rawText && input.data.rawText.trim()) {
    contacts = parseBulkContactsText(input.data.rawText);
  }

  if (contacts.length === 0) {
    throw new HttpError(400, "No valid phone numbers found. Choose a Contact Group or paste phone numbers.");
  }

  const summary = await enqueueBulkAutomationRuns({
    ownerId: owner,
    automationId: String(flow._id),
    contacts,
    source: "dashboard_bulk",
    requestedBy: String(request.user?.id ?? ""),
    maxBatch: 500,
  });

  response.status(202).json({ ok: true, ...summary });
}

export async function cancelAutomationRun(request: AuthenticatedRequest, response: Response) {
  const owner = ownerId(request);
  const automationId = flowId(request);
  await findOwnedAutomation(owner, automationId);
  const runId = String(request.params.runId ?? "");
  if (!isValidObjectId(runId)) throw new HttpError(404, "Workflow run not found.");
  const current = await AutomationRunModel.findOne({ _id: runId, ownerId: owner, automationId });
  if (!current) throw new HttpError(404, "Workflow run not found.");
  if (current.status === "cancelled") { response.json({ run: current }); return; }
  if (current.status === "running") throw new HttpError(409, "This step is processing. Try cancelling again after it reaches a waiting state.");
  if (current.status === "completed" || current.status === "failed") throw new HttpError(409, "This run has already finished.");
  const detail = current.waitKind === "call"
    ? "Cancelled by an operator. The call already in progress may still finish."
    : "Cancelled by an operator before the next step.";
  const run = await AutomationRunModel.findOneAndUpdate(
    { _id: runId, ownerId: owner, automationId, status: { $in: ["queued", "waiting"] } },
    {
      $set: { status: "cancelled", dueAt: null, leaseUntil: null, finishedAt: new Date(), error: detail },
      $push: { steps: { nodeId: current.currentNodeId, title: "Run cancelled", type: "system", status: "cancelled", detail, at: new Date() } },
      $inc: { __v: 1 },
    },
    { new: true },
  );
  if (!run) throw new HttpError(409, "The run changed while cancelling. Refresh and try again.");
  response.json({ run });
}

function timingSafeSecretMatches(expected: string, provided: string) {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function rotateAutomationWebhookSecret(request: AuthenticatedRequest, response: Response) {
  const flow = await findOwnedAutomation(ownerId(request), flowId(request));
  flow.webhookSecret = randomBytes(24).toString("hex");
  await flow.save();
  response.json({ flow });
}

export async function triggerAutomationWebhook(request: Request, response: Response) {
  const automationId = String(request.params.automationId ?? "");
  if (!isValidObjectId(automationId)) throw new HttpError(404, "Workflow not found.");

  const flow = await AutomationModel.findOne({ _id: automationId, status: "live", published: { $ne: null } });
  if (!flow || !flow.published) throw new HttpError(404, "Live workflow not found.");

  const expectedSecret = String(flow.webhookSecret || "").trim();
  const providedSecret = String(
    request.header("x-webhook-secret")
    || (typeof request.query.secret === "string" ? request.query.secret : "")
    || "",
  ).trim();
  if (!timingSafeSecretMatches(expectedSecret, providedSecret)) {
    throw new HttpError(401, "Invalid or missing webhook secret.");
  }

  const graph = normalizeAutomationGraph(flow.published as Parameters<typeof normalizeAutomationGraph>[0]);
  const trigger = graph.nodes.find((node) => node.type === "trigger");
  if (!trigger || trigger.config.event !== "webhook") {
    throw new HttpError(409, "This workflow is not configured with an External Webhook trigger.");
  }

  const body = (request.body && typeof request.body === "object") ? (request.body as Record<string, unknown>) : {};
  const rawPhone = String(
    body.phone ?? body.phoneNumber ?? body.mobile ?? body.contactPhone ?? body.customer_phone ?? "",
  ).trim();
  const cleanedDigits = cleanPhoneNumber(rawPhone);
  const phone = cleanedDigits ? `+${cleanedDigits}` : "";
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new HttpError(400, "Provide a valid phone number in `phone` (e.g. +919876543210).");
  }

  const keyword = String(trigger.config.keyword || "").trim().toLowerCase();
  if (keyword && !JSON.stringify(body).toLowerCase().includes(keyword)) {
    response.status(200).json({ ok: true, skipped: true, reason: `Payload did not match keyword filter "${trigger.config.keyword}".` });
    return;
  }

  const owner = String(flow.ownerId);
  const suppressed = await ContactSuppressionModel.exists({ ownerId: owner, phoneNumber: { $in: [phone, cleanedDigits] } });
  if (suppressed) {
    response.status(200).json({ ok: true, skipped: true, reason: "Contact is on the Do-Not-Call / opt-out list." });
    return;
  }

  const activeStatuses = ["queued", "running", "waiting"];
  const phoneVariants = [phone, cleanedDigits];
  const existingActive = await AutomationRunModel.findOne({
    ownerId: owner,
    automationId: flow._id,
    contactPhone: { $in: phoneVariants },
    status: { $in: activeStatuses },
  });
  if (existingActive) {
    response.status(200).json({ ok: true, deduplicated: true, runId: String(existingActive._id), status: existingActive.status });
    return;
  }

  if (await AutomationRunModel.countDocuments({ ownerId: owner, status: { $in: activeStatuses } }) >= 100) {
    throw new HttpError(429, "This workspace has reached its active workflow limit.");
  }

  const name = String(
    body.name ?? body.fullName ?? body.contactName ?? body.customer_name ?? "Webhook Lead",
  ).trim().slice(0, 120);
  const eventId = String(body.eventId ?? body.event_id ?? "").trim().slice(0, 160) || `webhook:${cleanedDigits}:${randomUUID()}`;
  const customNote = String(body.message ?? body.note ?? body.notes ?? body.summary ?? "").trim().slice(0, 500);

  let run;
  try {
    run = await AutomationRunModel.findOneAndUpdate(
      { ownerId: owner, automationId: flow._id, eventId },
      {
        $setOnInsert: {
          ownerId: owner,
          automationId: flow._id,
          version: flow.publishedVersion,
          graph: flow.published,
          eventId,
          contactName: name,
          contactPhone: phone,
          currentNodeId: trigger.id,
          status: "queued",
          context: {
            consentConfirmed: true,
            source: "webhook",
            webhookPayload: body,
            ...(customNote ? { lastMessageText: customNote } : {}),
          },
        },
      },
      { upsert: true, new: true },
    );
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
    run = await AutomationRunModel.findOne({ ownerId: owner, automationId: flow._id, eventId });
  }
  if (!run) throw new HttpError(500, "Could not enqueue webhook workflow run.");

  void processAutomationRuns().catch((error) => console.error("Webhook automation run failed to start.", error));
  response.status(202).json({ ok: true, runId: String(run._id), eventId, status: run.status });
}

function buildAgenticFallbackDraft(
  promptText: string,
  defaultAgentId: string,
  defaultPhoneId: string,
  defaultTemplateName: string,
) {
  const lower = promptText.toLowerCase();
  const isCaseFlow = lower.includes("support case") || lower.includes("sla") || lower.includes("ticket");
  const isPaymentFlow = lower.includes("razorpay") || lower.includes("payment");
  const isWebhookStart = lower.includes("webhook") || lower.includes("zapier") || lower.includes("meta ad");
  const isMissedCall = lower.includes("missed") || lower.includes("inbound call");
  const isWhatsAppStart = lower.includes("whatsapp") && (lower.includes("inbound") || lower.includes("receive") || lower.includes("when a lead messages") || lower.includes("arrives"));
  const isLeadImport = lower.includes("import") || lower.includes("campaign");

  if (isCaseFlow) {
    return {
      name: promptText.slice(0, 60).trim() || "Support Case SLA & Escalation Flow",
      description: `Case-based SLA automation generated from: "${promptText.slice(0, 180)}"`,
      graph: {
        schemaVersion: 1 as const,
        nodes: [
          { id: "trigger_1", type: "trigger" as const, title: "Support Case Opened", x: 60, y: 220, config: { event: "case_created", priority: "all", consentConfirmed: "true" } },
          { id: "wa_ack", type: "whatsapp" as const, title: "WhatsApp Case Ack", x: 360, y: 220, config: { messageMode: "ai_dynamic", aiPrompt: "Confirm to {{name}} that support case {{caseNumber}} is open and our team is working on it." } },
          { id: "wait_sla", type: "wait" as const, title: "Wait for Case SLA (30m)", x: 660, y: 220, config: { waitMode: "case_resolved", minutes: "30" } },
          { id: "cond_case", type: "condition" as const, title: "Case Resolved?", x: 960, y: 220, config: { conditionType: "case_status", value: "resolved" } },
          { id: "wa_csat", type: "whatsapp" as const, title: "WhatsApp CSAT Survey", x: 1260, y: 100, config: { messageMode: "ai_dynamic", aiPrompt: "Thank {{name}} for resolving {{caseNumber}} and ask them to rate their experience from 1 to 5." } },
          { id: "end_ok", type: "end" as const, title: "SLA Met & CSAT Sent", x: 1560, y: 100, config: { outcome: "SLA Met" } },
          { id: "alert_sla", type: "sms" as const, title: "Slack SLA Breach Alert", x: 1260, y: 340, config: { messageText: "⚠️ SLA Breach on {{caseNumber}} for {{name}} ({{phone}}). Status is still {{caseStatus}}!" } },
          { id: "call_esc", type: "call" as const, title: "AI Escalation Update Call", x: 1560, y: 340, config: { agentId: defaultAgentId || "auto", phoneNumberId: defaultPhoneId || "auto", windowStart: "09:00", windowEnd: "20:00", timezone: "Asia/Kolkata", maxRetries: "1", retryDelayMinutes: "10" } },
          { id: "end_esc", type: "end" as const, title: "Escalated", x: 1860, y: 340, config: { outcome: "SLA Escalated" } },
          { id: "end_esc_fail", type: "end" as const, title: "Escalation Logged", x: 1860, y: 500, config: { outcome: "Escalated (Unreached)" } },
        ],
        edges: [
          { id: "e1", source: "trigger_1", target: "wa_ack", sourceHandle: "default" as const },
          { id: "e2", source: "wa_ack", target: "wait_sla", sourceHandle: "default" as const },
          { id: "e3", source: "wait_sla", target: "cond_case", sourceHandle: "default" as const },
          { id: "e4_yes", source: "cond_case", target: "wa_csat", sourceHandle: "yes" as const },
          { id: "e5", source: "wa_csat", target: "end_ok", sourceHandle: "default" as const },
          { id: "e4_no", source: "cond_case", target: "alert_sla", sourceHandle: "no" as const },
          { id: "e6", source: "alert_sla", target: "call_esc", sourceHandle: "default" as const },
          { id: "e7", source: "call_esc", target: "end_esc", sourceHandle: "default" as const },
          { id: "e7_fail", source: "call_esc", target: "end_esc_fail", sourceHandle: "failed" as const },
        ],
      },
    };
  }

  if (isPaymentFlow) {
    const payTrigger = isWebhookStart ? "webhook" : isWhatsAppStart ? "whatsapp_inbound" : "manual";
    return {
      name: promptText.slice(0, 60).trim() || "Payment + Calendar + CRM Flow",
      description: `Omnichannel checkout & booking flow generated from: "${promptText.slice(0, 180)}"`,
      graph: {
        schemaVersion: 1 as const,
        nodes: [
          { id: "trigger_1", type: "trigger" as const, title: payTrigger === "webhook" ? "Webhook Lead" : "WhatsApp Inbound", x: 60, y: 220, config: { event: payTrigger, consentConfirmed: "true" } },
          { id: "calendar_1", type: "calendar" as const, title: "Book on Calendar", x: 360, y: 220, config: { calendarTitle: "Product Demo & Onboarding", durationMinutes: "30" } },
          { id: "crm_1", type: "crm" as const, title: "Sync Lead to CRM", x: 660, y: 220, config: { crmStage: "Appointment Booked", crmTag: "Booking-Initiated" } },
          { id: "payment_1", type: "payment" as const, title: "Razorpay Payment Link", x: 960, y: 220, config: { amount: "999", currency: "INR", description: "Booking fee for {{name}}", sendWhatsApp: "true" } },
          { id: "wait_pay", type: "wait" as const, title: "Wait for Payment (60m)", x: 1260, y: 220, config: { waitMode: "payment_paid", minutes: "60" } },
          { id: "cond_pay", type: "condition" as const, title: "Razorpay Paid?", x: 1560, y: 220, config: { conditionType: "payment_paid" } },
          { id: "alert_paid", type: "sms" as const, title: "Slack Payment Alert", x: 1860, y: 100, config: { messageText: "✅ {{name}} ({{phone}}) paid & booked! Slot: {{calendlyLink}}" } },
          { id: "end_paid", type: "end" as const, title: "Paid & Confirmed", x: 2160, y: 100, config: { outcome: "Paid & Confirmed" } },
          { id: "wa_nudge", type: "whatsapp" as const, title: "Payment Reminder", x: 1860, y: 340, config: { messageMode: "ai_dynamic", aiPrompt: "Send a friendly reminder to {{name}} with their Razorpay link {{paymentLink}} to confirm their slot." } },
          { id: "end_pending", type: "end" as const, title: "Reminder Sent", x: 2160, y: 340, config: { outcome: "Payment Pending" } },
        ],
        edges: [
          { id: "e1", source: "trigger_1", target: "calendar_1", sourceHandle: "default" as const },
          { id: "e2", source: "calendar_1", target: "crm_1", sourceHandle: "default" as const },
          { id: "e3", source: "crm_1", target: "payment_1", sourceHandle: "default" as const },
          { id: "e4", source: "payment_1", target: "wait_pay", sourceHandle: "default" as const },
          { id: "e5", source: "wait_pay", target: "cond_pay", sourceHandle: "default" as const },
          { id: "e6_yes", source: "cond_pay", target: "alert_paid", sourceHandle: "yes" as const },
          { id: "e7", source: "alert_paid", target: "end_paid", sourceHandle: "default" as const },
          { id: "e6_no", source: "cond_pay", target: "wa_nudge", sourceHandle: "no" as const },
          { id: "e8", source: "wa_nudge", target: "end_pending", sourceHandle: "default" as const },
        ],
      },
    };
  }

  const triggerEvent = isWebhookStart
    ? "webhook"
    : isMissedCall
      ? "missed_call"
      : isWhatsAppStart
        ? "whatsapp_inbound"
        : isLeadImport
          ? "contact_added"
          : "manual";

  const nodes = [
    {
      id: "trigger_1",
      type: "trigger" as const,
      title: isWebhookStart ? "External Webhook" : isMissedCall ? "Missed Call Trigger" : isWhatsAppStart ? "WhatsApp Inbound" : "Start Journey",
      x: 60,
      y: 220,
      config: {
        event: triggerEvent,
        consentConfirmed: "true",
        ...(triggerEvent === "contact_added" ? { campaignId: "all" } : {}),
        ...(triggerEvent === "missed_call" && defaultPhoneId ? { phoneNumberId: defaultPhoneId } : {}),
      },
    },
    {
      id: "wa_welcome",
      type: "whatsapp" as const,
      title: "AI WhatsApp Outreach",
      x: 370,
      y: 220,
      config: {
        messageMode: defaultTemplateName ? "template" : "ai_dynamic",
        templateName: defaultTemplateName || "appointment_confirmation_v1",
        language: "en",
        bodyVariables: "{{name}}, {{phone}}",
        aiPrompt: "Greet the lead warmly, share key highlights, and ask if they'd like a quick call or demo.",
      },
    },
    {
      id: "call_1",
      type: "call" as const,
      title: "AI Voice Qualification Call",
      x: 680,
      y: 220,
      config: {
        agentId: defaultAgentId || "auto",
        phoneNumberId: defaultPhoneId || "auto",
        windowStart: "09:00",
        windowEnd: "20:00",
        timezone: "Asia/Kolkata",
        maxRetries: "2",
        retryDelayMinutes: "15",
      },
    },
    {
      id: "decision_1",
      type: "decision" as const,
      title: "AI Agentic Router",
      x: 990,
      y: 220,
      config: {
        decisionType: "agentic",
        agentGoal: "Evaluate call outcome and WhatsApp reply to route Interested leads to Calendar & CRM, Callbacks to Wait & Retry.",
      },
    },
    {
      id: "calendar_1",
      type: "calendar" as const,
      title: "Book AI Consultation",
      x: 1300,
      y: 80,
      config: {
        calendarTitle: "Product Demo & Consultation",
        durationMinutes: "30",
      },
    },
    {
      id: "crm_1",
      type: "crm" as const,
      title: "Sync Qualified Lead to CRM",
      x: 1610,
      y: 80,
      config: {
        crmStage: "Qualified",
        crmTag: "Hot-Lead",
      },
    },
    {
      id: "wait_retry",
      type: "wait" as const,
      title: "Wait Before Follow-up",
      x: 1300,
      y: 260,
      config: {
        minutes: "60",
      },
    },
    {
      id: "wa_followup",
      type: "whatsapp" as const,
      title: "Send Follow-up WhatsApp",
      x: 1610,
      y: 260,
      config: {
        messageMode: "ai_dynamic",
        templateName: defaultTemplateName || "lead_followup_special_offer",
        language: "en",
        aiPrompt: "Send a friendly follow-up message with a booking link in case we missed them.",
      },
    },
    {
      id: "end_won",
      type: "end" as const,
      title: "Booked & Synced",
      x: 1920,
      y: 80,
      config: { outcome: "Qualified & Booked" },
    },
    {
      id: "end_nurture",
      type: "end" as const,
      title: "Nurture Complete",
      x: 1920,
      y: 280,
      config: { outcome: "Follow-up Sent" },
    },
  ];

  const edges = [
    { id: "e1", source: "trigger_1", target: "wa_welcome", sourceHandle: "default" as const },
    { id: "e2", source: "wa_welcome", target: "call_1", sourceHandle: "default" as const },
    { id: "e3", source: "call_1", target: "decision_1", sourceHandle: "default" as const },
    { id: "e3_fail", source: "call_1", target: "wait_retry", sourceHandle: "failed" as const },
    { id: "e4_int", source: "decision_1", target: "calendar_1", sourceHandle: "interested" as const },
    { id: "e4_cb", source: "decision_1", target: "wait_retry", sourceHandle: "callback" as const },
    { id: "e4_not", source: "decision_1", target: "end_nurture", sourceHandle: "not_interested" as const },
    { id: "e4_unk", source: "decision_1", target: "wa_followup", sourceHandle: "unknown" as const },
    { id: "e5", source: "calendar_1", target: "crm_1", sourceHandle: "default" as const },
    { id: "e6", source: "crm_1", target: "end_won", sourceHandle: "default" as const },
    { id: "e7", source: "wait_retry", target: "wa_followup", sourceHandle: "default" as const },
    { id: "e8", source: "wa_followup", target: "end_nurture", sourceHandle: "default" as const },
  ];

  return {
    name: promptText.slice(0, 60).trim() || "Autonomous AI Voice + WhatsApp Flow",
    description: `Agentic omnichannel workflow generated from: "${promptText.slice(0, 180)}"`,
    graph: {
      schemaVersion: 1 as const,
      nodes,
      edges,
    },
  };
}

export async function generateAutomation(request: AuthenticatedRequest, response: Response) {
  const owner = ownerId(request);
  const prompt = z.string().trim().min(10).max(2000).safeParse(request.body?.prompt);
  if (!prompt.success) throw new HttpError(400, "Describe the workflow in 10 to 2,000 characters.");

  // Discover workspace defaults so generated workflows are pre-configured and publish-ready
  const [liveAgent, readyPhone, approvedTemplate] = await Promise.all([
    VoiceAgentModel.findOne({ ownerId: owner, status: "Live" }).sort({ updatedAt: -1 }).lean().catch(() => null),
    PhoneNumberModel.findOne({ ownerId: owner, status: "Ready", direction: { $in: ["Outbound", "Both"] } }).lean().catch(() => null),
    WhatsAppTemplateModel.findOne({ ownerId: owner, status: "APPROVED" }).sort({ createdAt: -1 }).lean().catch(() => null),
  ]);

  const defaultAgentId = liveAgent ? String(liveAgent._id) : "auto";
  const defaultPhoneId = readyPhone ? String(readyPhone._id) : "auto";
  const defaultTemplateName = approvedTemplate?.name || "appointment_confirmation_v1";

  let draft: ReturnType<typeof parseDraft> | null = null;

  if (env.openaiApiKey) {
    try {
      const aiResponse = await fetch(`${env.openaiBaseUrl}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(25_000),
        headers: { Authorization: `Bearer ${env.openaiApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.ASSISTANT_MODEL?.trim() || "gpt-4o-mini",
          temperature: 0.2,
          response_format: { type: "json_object" },
          max_tokens: 2200,
          messages: [
            {
              role: "system",
              content: `Return JSON with exactly {name,description,graph:{schemaVersion:1,nodes:[{id,type,title,x,y,config}],edges:[{id,source,target,sourceHandle}]}}. Supported types: trigger,call,whatsapp,decision,condition,wait,crm,calendar,payment,case,sms,end. Use a finite left-to-right graph, one trigger, at least one end, no cycles. Coordinates 0-10000. All config values strings. For trigger use {event:'manual',consentConfirmed:'true'} or webhook/whatsapp_inbound/whatsapp_form_submitted/missed_call/contact_added/case_created/case_resolved. For call use {agentId:'${defaultAgentId}',phoneNumberId:'${defaultPhoneId}',windowStart:'09:00',windowEnd:'20:00',timezone:'Asia/Kolkata',maxRetries:'2',retryDelayMinutes:'15'}. For whatsapp use {messageMode:'template',templateName:'${defaultTemplateName}',language:'en',bodyVariables:'{{name}}, {{phone}}'} or messageMode:'ai_dynamic' with aiPrompt. For decision use {decisionType:'agentic',agentGoal:'...'}. For condition use conditionType in outcome/whatsapp_status/whatsapp_reply_contains/whatsapp_reply_equals/has_replied/payment_paid/case_status/case_priority/contact_tag. For case (Support Case ticket) use {subject:'Support issue for {{name}}',category:'Support',priority:'high',notifyCustomer:'true'}. For crm use {crmStage:'Qualified',crmTag:'AI-Qualified'}. For calendar use {calendarTitle:'AI Consultation',durationMinutes:'30'}. For payment (Razorpay Payment Link sent via WhatsApp) use {amount:'999',currency:'INR',description:'Booking Fee',sendWhatsApp:'true'}. For wait set minutes between 1 and 43200 and optional waitMode:'duration'|'whatsapp_reply'|'payment_paid'|'case_resolved'. Decision branches: interested, callback, not_interested, unknown. Call branches: default, failed. Condition branches: yes, no. Other outgoing edges: default.`,
            },
            { role: "user", content: prompt.data },
          ],
        }),
      });
      if (aiResponse.ok) {
        const result = (await aiResponse.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const parsedJson = JSON.parse(result.choices?.[0]?.message?.content ?? "");
        draft = parseDraft(parsedJson);
      }
    } catch {
      // Fallback to deterministic agentic graph builder below
    }
  }

  if (!draft) {
    draft = parseDraft(
      buildAgenticFallbackDraft(prompt.data, defaultAgentId, defaultPhoneId, defaultTemplateName),
    );
  }

  response.json({ draft, issues: await validateAutomation(owner, draft.graph, planFeatures(request)) });
}
