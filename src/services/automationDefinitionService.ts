import { randomBytes } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { AutomationModel } from "../models/Automation.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { CampaignModel } from "../models/Campaign.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { WhatsAppTemplateModel } from "../models/WhatsAppEntities.js";
import { HttpError } from "../utils/httpError.js";
import { decryptSecret } from "../utils/secretCrypto.js";
import { getWhatsAppTemplate, type WhatsAppTemplate } from "./whatsappService.js";

export const nodeTypes = ["trigger", "call", "whatsapp", "decision", "condition", "wait", "end", "sms", "crm", "calendar", "payment", "case"] as const;
export const nodeSchema = z.object({
  id: z.string().min(1).max(80),
  type: z.enum(nodeTypes),
  title: z.string().trim().min(1).max(100),
  x: z.number().finite().min(0).max(10000),
  y: z.number().finite().min(0).max(10000),
  config: z.record(z.string().max(80), z.string().max(1000)).default({}),
}).strict();
export const edgeSchema = z.object({
  id: z.string().min(1).max(80),
  source: z.string().min(1).max(80),
  target: z.string().min(1).max(80),
  sourceHandle: z.enum(["default", "interested", "callback", "not_interested", "unknown", "yes", "no", "failed"]).default("default"),
}).strict();
export const graphSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(nodeSchema).min(1).max(100),
  edges: z.array(edgeSchema).max(200),
}).strict();
export const draftSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(""),
  graph: graphSchema,
  revision: z.number().int().min(1).optional(),
}).strict();
export type AutomationGraph = z.infer<typeof graphSchema>;
export type AutomationNode = AutomationGraph["nodes"][number];
export type AutomationEdge = AutomationGraph["edges"][number];
export type AutomationIssue = { nodeId: string; message: string };

// Reparse stored Mixed documents so legacy empty settings are restored and corrupt snapshots fail closed.
export function normalizeAutomationGraph(graph: AutomationGraph): AutomationGraph {
  const parsed = graphSchema.safeParse(graph);
  if (!parsed.success) throw new HttpError(409, "Stored workflow version is invalid. Contact support before running it.");
  return parsed.data;
}

export function parseDraft(body: unknown) {
  const parsed = draftSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid automation.");
  return parsed.data;
}

export async function validateAutomation(ownerId: string, graph: AutomationGraph, features?: Record<string, unknown>, verifyTemplates = false): Promise<AutomationIssue[]> {
  const issues: AutomationIssue[] = [];
  let whatsAppIntegration: { secretEncrypted?: string; metadata?: unknown } | null = null;
  if (verifyTemplates && graph.nodes.some((node) => node.type === "whatsapp")) {
    whatsAppIntegration = await ProviderIntegrationModel.findOne({ ownerId, provider: "whatsapp", status: "connected" }).select("+secretEncrypted");
  }
  const ids = new Set(graph.nodes.map((node) => node.id));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const triggers = graph.nodes.filter((node) => node.type === "trigger");
  if (ids.size !== graph.nodes.length) issues.push({ nodeId: "", message: "Step IDs must be unique." });
  if (new Set(graph.edges.map((edge) => edge.id)).size !== graph.edges.length) issues.push({ nodeId: "", message: "Connection IDs must be unique." });
  if (triggers.length !== 1) issues.push({ nodeId: "", message: "Add exactly one start trigger." });
  if (!graph.nodes.some((node) => node.type === "end")) issues.push({ nodeId: "", message: "Add an End block." });
  for (const edge of graph.edges) {
    const source = nodeById.get(edge.source);
    if (!source || !nodeById.has(edge.target) || edge.source === edge.target) issues.push({ nodeId: edge.source, message: "Connection must join two different existing steps." });
    if (source?.type === "end") issues.push({ nodeId: source.id, message: "End blocks cannot connect to another step." });
    const allowed = source?.type === "decision" ? ["interested", "callback", "not_interested", "unknown"]
      : source?.type === "condition" ? ["yes", "no"]
        : source?.type === "call" ? ["default", "failed"] : ["default"];
    if (source && !allowed.includes(edge.sourceHandle)) issues.push({ nodeId: source.id, message: `${edge.sourceHandle.replaceAll("_", " ")} is not a valid branch for ${source.title}.` });
  }
  for (const node of graph.nodes) {
    const outgoing = graph.edges.filter((edge) => edge.source === node.id);
    if (node.type !== "end" && outgoing.length === 0) issues.push({ nodeId: node.id, message: `${node.title} needs a next step.` });
    if (new Set(outgoing.map((edge) => edge.sourceHandle)).size !== outgoing.length) issues.push({ nodeId: node.id, message: "Each branch can connect to only one step." });
    const required = node.type === "decision" ? ["interested", "callback", "not_interested", "unknown"] : node.type === "condition" ? ["yes", "no"] : node.type === "call" ? ["default", "failed"] : node.type === "end" ? [] : ["default"];
    for (const handle of required) if (!outgoing.some((edge) => edge.sourceHandle === handle)) issues.push({ nodeId: node.id, message: `Connect the ${handle.replaceAll("_", " ")} branch.` });
    if (node.type === "trigger") {
      if (!["manual", "contact_added", "missed_call", "whatsapp_inbound", "whatsapp_form_submitted", "webhook", "case_created", "case_resolved"].includes(node.config.event ?? "")) issues.push({ nodeId: node.id, message: "Select a supported start event." });
      if (node.config.event === "contact_added") {
        if (!node.config.campaignId || (node.config.campaignId !== "all" && !await CampaignModel.exists({ _id: node.config.campaignId, ownerId }).catch(() => null))) issues.push({ nodeId: node.id, message: "Choose a campaign in this workspace. Only newly imported leads with confirmed workflow consent will start." });
      }
      if (node.config.event === "missed_call") {
        if (!node.config.phoneNumberId || !await PhoneNumberModel.exists({ _id: node.config.phoneNumberId, ownerId, status: "Ready", direction: { $in: ["Inbound", "Both"] } }).catch(() => null)) issues.push({ nodeId: node.id, message: "Choose a ready inbound phone number." });
        if (node.config.consentConfirmed !== "true") issues.push({ nodeId: node.id, message: "Confirm that contacts from this inbound number may receive workflow follow-up." });
      }
      if (node.config.event === "whatsapp_inbound" || node.config.event === "whatsapp_form_submitted") {
        if (node.config.consentConfirmed !== "true") issues.push({ nodeId: node.id, message: "Confirm that WhatsApp contacts may receive workflow follow-up." });
      }
      if (node.config.event === "webhook") {
        if (node.config.consentConfirmed !== "true") issues.push({ nodeId: node.id, message: "Confirm that contacts submitted via this webhook have consented to follow-up." });
      }
      if (node.config.event === "case_created" || node.config.event === "case_resolved") {
        if (node.config.consentConfirmed !== "true") issues.push({ nodeId: node.id, message: "Confirm that support case contacts may receive workflow follow-up." });
      }
    }
    if (node.type === "call") {
      if (features && features.outboundCalling !== true) issues.push({ nodeId: node.id, message: "Outbound calling is not included in this customer plan." });
      const isAutoAgent = !node.config.agentId || node.config.agentId === "auto";
      if (!isAutoAgent && !await VoiceAgentModel.exists({ _id: node.config.agentId, ownerId }).catch(() => null)) {
        issues.push({ nodeId: node.id, message: "Choose a valid voice agent in this workspace (or leave on Auto-Select)." });
      }
      const isAutoNumber = !node.config.phoneNumberId || node.config.phoneNumberId === "auto";
      if (!isAutoNumber && !await PhoneNumberModel.exists({ _id: node.config.phoneNumberId, ownerId }).catch(() => null)) {
        issues.push({ nodeId: node.id, message: "Choose a valid outbound phone number (or leave on Auto-Select)." });
      }
      if (node.config.timezone) { try { new Intl.DateTimeFormat("en", { timeZone: node.config.timezone }); } catch { issues.push({ nodeId: node.id, message: "Enter a valid IANA time zone." }); } }
      for (const key of ["windowStart", "windowEnd"]) if (node.config[key] && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(node.config[key])) issues.push({ nodeId: node.id, message: "Calling window must use HH:mm time." });
      if (node.config.maxRetries) {
        const retries = Number(node.config.maxRetries);
        if (!Number.isInteger(retries) || retries < 0 || retries > 5) issues.push({ nodeId: node.id, message: "Call retries must be between 0 and 5." });
      }
      if (node.config.retryDelayMinutes) {
        const delay = Number(node.config.retryDelayMinutes);
        if (!Number.isFinite(delay) || delay < 1 || delay > 1440) issues.push({ nodeId: node.id, message: "Call retry delay must be between 1 and 1440 minutes." });
      }
    }
    if (node.type === "whatsapp") {
      if (features && features.integrations !== true) issues.push({ nodeId: node.id, message: "Integrations are not included in this customer plan." });
      const isAiMode = node.config.messageMode === "ai_dynamic";
      if (!isAiMode && !node.config.templateName) {
        issues.push({ nodeId: node.id, message: "Choose a WhatsApp template or switch to AI Dynamic Message mode." });
      }
      if (node.config.bodyVariables && node.config.bodyVariables.split(",").length > 10) {
        issues.push({ nodeId: node.id, message: "A template can use at most 10 body variables." });
      }
      if (!isAiMode && verifyTemplates && node.config.templateName) {
        const localTemplate = await WhatsAppTemplateModel.findOne({ ownerId, name: node.config.templateName }).catch(() => null);
        if (!localTemplate && whatsAppIntegration?.secretEncrypted) {
          try {
            const wabaId = String((whatsAppIntegration.metadata as Record<string, unknown> | null)?.wabaId ?? "");
            const template = await getWhatsAppTemplate(wabaId, decryptSecret(whatsAppIntegration.secretEncrypted), node.config.templateName, node.config.language || "en");
            if (!template || template.status !== "APPROVED") issues.push({ nodeId: node.id, message: "Choose a template that is approved in your WhatsApp workspace or Meta account." });
          } catch {
            // Allow fallback if Meta Graph API is unreachable and template name is provided
          }
        }
      }
    }
    if (node.type === "condition") {
      const type = node.config.conditionType || "outcome";
      if (type !== "has_replied" && type !== "payment_paid" && !node.config.value) {
        issues.push({ nodeId: node.id, message: "Enter the condition value to compare." });
      }
    }
    if (node.type === "payment") {
      const amount = Number(node.config.amount || 0);
      if (!Number.isFinite(amount) || amount < 1) {
        issues.push({ nodeId: node.id, message: "Enter a valid Razorpay payment amount (minimum 1)." });
      }
    }
    if (node.type === "case") {
      if (node.config.priority && !["low", "medium", "high", "urgent"].includes(node.config.priority)) {
        issues.push({ nodeId: node.id, message: "Case priority must be low, medium, high, or urgent." });
      }
    }
    if (node.type === "wait") {
      const mode = node.config.waitMode || "duration";
      if (!["duration", "whatsapp_reply", "payment_paid", "case_resolved"].includes(mode)) {
        issues.push({ nodeId: node.id, message: "Select a supported wait mode." });
      }
      if (!Number.isFinite(Number(node.config.minutes)) || Number(node.config.minutes) < 1 || Number(node.config.minutes) > 43200) {
        issues.push({ nodeId: node.id, message: "Wait timeout/duration must be between 1 minute and 30 days." });
      }
    }
  }
  const totalWaitMinutes = graph.nodes.filter((node) => node.type === "wait").reduce((sum, node) => sum + Number(node.config.minutes || 0), 0);
  if (totalWaitMinutes > 129_600) issues.push({ nodeId: "", message: "A workflow can wait at most 90 days in total." });
  const reachable = new Set<string>();
  const visiting = new Set<string>();
  let cycle = false;
  const walk = (id: string) => {
    if (visiting.has(id)) { cycle = true; return; }
    if (reachable.has(id)) return;
    visiting.add(id);
    for (const edge of graph.edges.filter((item) => item.source === id)) walk(edge.target);
    visiting.delete(id);
    reachable.add(id);
  };
  if (triggers[0]) walk(triggers[0].id);
  if (cycle) issues.push({ nodeId: "", message: "Loops are not supported in this version." });
  for (const node of graph.nodes) if (!reachable.has(node.id)) issues.push({ nodeId: node.id, message: `${node.title} cannot be reached from the trigger.` });
  return issues;
}

export function whatsAppTemplateIssues(node: AutomationNode, template: WhatsAppTemplate): AutomationIssue[] {
  const issues: AutomationIssue[] = [];
  const body = template.components.find((component) => component.type?.toUpperCase() === "BODY");
  const placeholders = [...(body?.text ?? "").matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
  const requiredCount = placeholders.length ? Math.max(...placeholders) : 0;
  const providedCount = (node.config.bodyVariables ?? "").split(",").map((value) => value.trim()).filter(Boolean).length;
  if (requiredCount !== providedCount) issues.push({ nodeId: node.id, message: `This template requires ${requiredCount} body variable${requiredCount === 1 ? "" : "s"}; map exactly that many values.` });
  if (template.components.some((component) => component.type?.toUpperCase() !== "BODY" && (component.format && component.format !== "TEXT" || /\{\{\d+\}\}/.test(JSON.stringify(component))))) {
    issues.push({ nodeId: node.id, message: "This template needs header or button parameters that this workflow block does not support." });
  }
  return issues;
}

export async function findOwnedAutomation(ownerId: string, id: string) {
  const automation = await AutomationModel.findOne({ _id: id, ownerId }).catch(() => null);
  if (!automation) throw new HttpError(404, "Workflow not found.");
  if (!automation.webhookSecret) {
    automation.webhookSecret = randomBytes(24).toString("hex");
    await AutomationModel.updateOne({ _id: automation._id }, { $set: { webhookSecret: automation.webhookSecret } }).catch(() => undefined);
  }
  automation.draft = normalizeAutomationGraph(automation.draft as AutomationGraph);
  if (automation.published) automation.published = normalizeAutomationGraph(automation.published as AutomationGraph);
  return automation;
}
