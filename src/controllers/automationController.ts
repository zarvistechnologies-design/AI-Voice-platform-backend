import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { isValidObjectId, startSession } from "mongoose";
import { z } from "zod";
import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WhiteLabelEntitledRequest } from "../middleware/whiteLabelEntitlements.js";
import { AutomationModel, AutomationRunModel, AutomationVersionModel } from "../models/Automation.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { WhatsAppTemplateModel } from "../models/WhatsAppEntities.js";
import { HttpError } from "../utils/httpError.js";
import { findOwnedAutomation, graphSchema, normalizeAutomationGraph, parseDraft, validateAutomation } from "../services/automationDefinitionService.js";
import { processAutomationRuns } from "../services/automationRuntimeService.js";
import { simulateAutomation } from "../services/automationSimulationService.js";

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
  if (await AutomationRunModel.countDocuments({ ownerId: owner, status: { $in: activeStatuses } }) >= 100) {
    throw new HttpError(429, "This workspace has reached its active workflow limit. Try again when a run finishes.");
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

function buildAgenticFallbackDraft(
  promptText: string,
  defaultAgentId: string,
  defaultPhoneId: string,
  defaultTemplateName: string,
) {
  const lower = promptText.toLowerCase();
  const isMissedCall = lower.includes("missed") || lower.includes("inbound call");
  const isWhatsAppStart = lower.includes("whatsapp") && (lower.includes("inbound") || lower.includes("receive") || lower.includes("when a lead messages"));
  const isLeadImport = lower.includes("import") || lower.includes("campaign");

  const triggerEvent = isMissedCall
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
      title: isMissedCall ? "Missed Call Trigger" : isWhatsAppStart ? "WhatsApp Inbound" : "Start Journey",
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
              content: `Return JSON with exactly {name,description,graph:{schemaVersion:1,nodes:[{id,type,title,x,y,config}],edges:[{id,source,target,sourceHandle}]}}. Supported types: trigger,call,whatsapp,decision,condition,wait,crm,calendar,payment,sms,end. Use a finite left-to-right graph, one trigger, at least one end, no cycles. Coordinates 0-10000. All config values strings. For trigger use {event:'manual',consentConfirmed:'true'} or whatsapp_inbound/missed_call/contact_added. For call use {agentId:'${defaultAgentId}',phoneNumberId:'${defaultPhoneId}',windowStart:'09:00',windowEnd:'20:00',timezone:'Asia/Kolkata'}. For whatsapp use {messageMode:'template',templateName:'${defaultTemplateName}',language:'en',bodyVariables:'{{name}}, {{phone}}'}. For decision use {decisionType:'agentic'}. For crm use {crmStage:'Qualified',crmTag:'AI-Qualified'}. For calendar use {calendarTitle:'AI Consultation',durationMinutes:'30'}. For payment (Razorpay Payment Link sent via WhatsApp) use {amount:'999',currency:'INR',description:'Booking Fee',sendWhatsApp:'true'}. For wait set minutes between 1 and 43200. Decision branches: interested, callback, not_interested, unknown. Call branches: default, failed. Condition branches: yes, no. Other outgoing edges: default.`,
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
