import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { AutomationRunModel } from "../models/Automation.js";
import { ContactSuppressionModel } from "../models/ContactSuppression.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import {
  WhatsAppAgentConfigModel,
  WhatsAppCampaignModel,
  WhatsAppCampaignRecipientModel,
  WhatsAppContactModel,
  WhatsAppConversationModel,
  WhatsAppMessageModel,
  WhatsAppSupportCaseModel,
  WhatsAppTemplateModel,
} from "../models/WhatsAppEntities.js";
import { HttpError } from "../utils/httpError.js";
import { decryptSecret } from "../utils/secretCrypto.js";
import { assertCallCapacity } from "./billingService.js";
import { formatKnowledgeContext, searchKnowledge } from "./knowledgeService.js";
import { startOutboundCall } from "./livekitService.js";
import { acquirePhoneNumberCallAdmission } from "./phoneNumberCallAdmissionService.js";
import { cleanPhoneNumber, listWabaTemplates, sendWhatsAppMessage } from "./whatsappService.js";
import { notifyConnectedSlack, syncLeadToConnectedCrms } from "./workflowIntegrationsService.js";
import { processAutomationRuns, triggerCaseAutomations } from "./automationRuntimeService.js";

let campaignWorkerRunning = false;

export async function getConnectedWhatsAppForOrg(ownerId: string, preferredPhoneNumberId?: string) {
  const integrations = await ProviderIntegrationModel.find({
    ownerId,
    provider: "whatsapp",
    status: "connected",
  })
    .select("+secretEncrypted")
    .sort({ createdAt: 1 });

  if (integrations.length === 0) return null;

  const integration =
    (preferredPhoneNumberId?.trim()
      ? integrations.find((item) => item.accountId === preferredPhoneNumberId.trim())
      : undefined) ||
    integrations.find((item) => Boolean((item.metadata as Record<string, unknown> | undefined)?.isPrimary)) ||
    integrations[0];

  if (!integration || !integration.secretEncrypted) return null;

  try {
    const accessToken = decryptSecret(integration.secretEncrypted);
    const phoneNumberId = integration.accountId;
    const metadata = (integration.metadata || {}) as Record<string, unknown>;
    return {
      accessToken,
      phoneNumberId,
      wabaId: String(metadata.wabaId || ""),
      displayPhoneNumber: String(metadata.displayPhoneNumber || ""),
      metadata,
    };
  } catch {
    return null;
  }
}

function toE164Phone(raw: string): string {
  const cleaned = cleanPhoneNumber(raw);
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

export async function initiateVoiceCallForWhatsAppContact(
  ownerId: string,
  input: {
    contactPhone: string;
    contactName?: string;
    voiceAgentId?: string;
    conversationId?: string;
  },
): Promise<{ callId: string; agentName: string; fromNumber: string }> {
  const targetPhone = toE164Phone(input.contactPhone);
  const digits = targetPhone.replace(/\D/g, "");
  if (digits.length < 8) {
    throw new HttpError(400, "Customer phone number is invalid for calling.");
  }

  const suppressed = await ContactSuppressionModel.exists({
    ownerId,
    phone: { $in: [targetPhone, digits] },
  });
  if (suppressed) {
    throw new HttpError(409, "Contact is on the do-not-call suppression list.");
  }

  const config = await WhatsAppAgentConfigModel.findOne({ ownerId });
  const preferredAgentId = input.voiceAgentId?.trim() || config?.voiceAgentId?.trim() || "";

  let agent = preferredAgentId
    ? await VoiceAgentModel.findOne({ _id: preferredAgentId, ownerId, status: "Live" })
    : null;
  if (!agent) {
    agent = await VoiceAgentModel.findOne({ ownerId, status: "Live" }).sort({ updatedAt: -1 });
  }
  if (!agent) {
    throw new HttpError(409, "No Live Voice AI Agent found in this workspace. Publish a Voice Agent first.");
  }

  let phone = await PhoneNumberModel.findOne({
    ownerId,
    agentId: agent._id,
    status: "Ready",
    direction: { $in: ["Outbound", "Both"] },
  });
  if (!phone) {
    phone = await PhoneNumberModel.findOne({
      ownerId,
      status: "Ready",
      direction: { $in: ["Outbound", "Both"] },
    });
  }
  if (!phone) {
    throw new HttpError(409, "No Ready Outbound phone number is assigned to place Voice AI calls.");
  }

  await assertCallCapacity(ownerId);
  const admission = await acquirePhoneNumberCallAdmission(ownerId, phone.id);
  try {
    const result = await startOutboundCall(agent, ownerId, targetPhone, phone.number, {
      phoneNumberId: phone.id,
      callAdmission: admission,
      telephonyProvider: phone.provider,
      outboundTrunkId: phone.outboundTrunkId,
      metadata: {
        source: "whatsapp",
        ...(input.conversationId ? { whatsappConversationId: input.conversationId } : {}),
        ...(input.contactName ? { contactName: input.contactName } : {}),
      },
    });
    return { callId: result.callId, agentName: agent.name, fromNumber: phone.number };
  } finally {
    await admission.release();
  }
}

function placeholderCount(text: string): number {
  const matches = text.match(/\{\{\d+\}\}/g) || [];
  let maxIndex = 0;
  for (const m of matches) {
    const num = Number(m.replace(/\D/g, ""));
    if (num > maxIndex) maxIndex = num;
  }
  return maxIndex;
}

function campaignVariableValue(contact: { name?: string; email?: string; customAttributes?: unknown }, phone: string, index: number, mappings: Record<string, string>): string {
  const mapping = mappings[String(index)] || (index === 1 ? "name" : index === 2 ? "phone" : index === 3 ? "email" : "");
  if (mapping === "name") return contact.name || "";
  if (mapping === "phone") return phone;
  if (mapping === "email") return contact.email || "";
  if (mapping.startsWith("static:")) return mapping.slice(7);
  if (mapping.startsWith("attribute:")) {
    const key = mapping.slice(10);
    const custom = contact.customAttributes && typeof contact.customAttributes === "object"
      ? contact.customAttributes as Record<string, unknown>
      : {};
    const value = custom[key];
    return value == null ? "" : String(value);
  }
  return "";
}

export async function dispatchWhatsAppCampaign(campaignId: string): Promise<void> {
  const now = new Date();
  const leaseId = randomUUID();
  const campaign = await WhatsAppCampaignModel.findOneAndUpdate({
    _id: campaignId,
    $or: [
      { status: "scheduled", scheduledAt: { $lte: now } },
      { status: "running", $or: [{ leaseExpiresAt: { $lte: now } }, { leaseExpiresAt: { $exists: false } }] },
    ],
  }, {
    $set: { status: "running", sentAt: now, leaseId, leaseExpiresAt: new Date(now.getTime() + 120_000) },
  }, { new: false });
  if (!campaign) return;
  if (campaign.status === "running") {
    // The previous worker expired or crashed mid-send. A provider call that was
    // in flight has an unknown outcome, so mark it and never resend blindly.
    await WhatsAppCampaignRecipientModel.updateMany(
      { campaignId: campaign._id, status: "sending" },
      { $set: { status: "unknown", lastError: "Worker lease expired during send; provider outcome is unknown, so it was not retried." } },
    );
    const durableSendHistory = await WhatsAppCampaignRecipientModel.exists({ campaignId: campaign._id });
    if (!durableSendHistory) {
      await WhatsAppCampaignModel.updateOne(
        { _id: campaign._id, leaseId },
        { $set: { status: "failed", failureReason: "This older campaign has no recipient send history. It was stopped to prevent duplicate delivery.", leaseId: "" }, $unset: { leaseExpiresAt: 1 } },
      );
      return;
    }
  }

  const ownerId = campaign.ownerId;
  const [template, rawContacts, connection] = await Promise.all([
    WhatsAppTemplateModel.findOne({ _id: campaign.templateId, ownerId }),
    WhatsAppContactModel.find({
      ownerId,
      groupIds: campaign.groupId,
      status: "subscribed",
      marketingOptInAt: { $exists: true },
    }).sort({ createdAt: 1 }),
    getConnectedWhatsAppForOrg(ownerId, campaign.senderPhoneNumberId),
  ]);
  const contacts = Array.from(
    new Map(rawContacts.map((contact) => [cleanPhoneNumber(contact.phoneNumber), contact])).values(),
  );

  if (!template) {
    await WhatsAppCampaignModel.updateOne(
      { _id: campaign._id, leaseId },
      { $set: { status: "failed", failureReason: "The selected template no longer exists.", leaseId: "" }, $unset: { leaseExpiresAt: 1 } },
    );
    return;
  }

  if (template.status !== "APPROVED" || ["IMAGE", "VIDEO", "DOCUMENT"].includes(String(template.headerType))) {
    await WhatsAppCampaignModel.updateOne(
      { _id: campaign._id, leaseId },
      { $set: { status: "failed", failureReason: template.status !== "APPROVED" ? "The template is no longer approved by Meta." : "Campaign sending for media-header templates is not configured.", leaseId: "" }, $unset: { leaseExpiresAt: 1 } },
    );
    return;
  }

  if (!connection) {
    await WhatsAppCampaignModel.updateOne(
      { _id: campaign._id, leaseId },
      {
        $set: {
          status: "failed",
          failureReason: "The selected WhatsApp number is disconnected.",
          "stats.recipients": contacts.length,
          "stats.sent": 0,
          "stats.failed": contacts.length,
          leaseId: "",
        },
        $unset: { leaseExpiresAt: 1 },
      },
    );
    return;
  }

  const varCount = placeholderCount(template.bodyText || "");
  const variableMappings = campaign.variableMappings && typeof campaign.variableMappings === "object"
    ? campaign.variableMappings as Record<string, string>
    : {};
  const campaignRecipients = [];
  for (const contact of contacts) {
    campaignRecipients.push(await WhatsAppCampaignRecipientModel.findOneAndUpdate(
      { campaignId: campaign._id, contactId: contact._id },
      { $setOnInsert: { ownerId, campaignId: campaign._id, contactId: contact._id, phoneNumber: cleanPhoneNumber(contact.phoneNumber), status: "pending" } },
      { upsert: true, new: true },
    ));
  }
  const eligibleContactIds = contacts.map((contact) => contact._id);
  await WhatsAppCampaignRecipientModel.updateMany(
    { campaignId: campaign._id, status: "pending", contactId: { $nin: eligibleContactIds } },
    { $set: { status: "failed", lastError: "Contact is no longer subscribed or is no longer in the campaign group." } },
  );
  const BATCH_SIZE = 20;

  for (let idx = 0; idx < contacts.length; idx += 1) {
    if (!(await WhatsAppCampaignModel.exists({ _id: campaign._id, leaseId }))) return;
    const contact = contacts[idx];
    let recipient = campaignRecipients[idx];
    if (recipient.status !== "pending") continue;
    if (idx > 0 && idx % BATCH_SIZE === 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const phone = cleanPhoneNumber(contact.phoneNumber);
    if (!phone || phone.length < 8) {
      await WhatsAppCampaignRecipientModel.updateOne({ _id: recipient._id, status: "pending" }, { $set: { status: "failed", lastError: "Invalid phone number." } });
      continue;
    }

    const claimedRecipient = await WhatsAppCampaignRecipientModel.findOneAndUpdate(
      { _id: recipient._id, status: "pending" },
      { $set: { status: "sending", attemptedAt: new Date() }, $inc: { attempts: 1 } },
      { new: true },
    );
    if (!claimedRecipient) continue;

    await WhatsAppCampaignModel.updateOne(
      { _id: campaign._id, leaseId },
      { $set: { leaseExpiresAt: new Date(Date.now() + 120_000) } },
    );
    if (!(await WhatsAppContactModel.exists({ _id: contact._id, ownerId, status: "subscribed" }))) {
      await WhatsAppCampaignRecipientModel.updateOne({ _id: recipient._id, status: "sending" }, { $set: { status: "failed", lastError: "Contact opted out before the campaign send." } });
      continue;
    }

    const bodyParams: Array<{ type: "text"; text: string }> = [];
    for (let i = 1; i <= varCount; i += 1) {
      const val = campaignVariableValue(contact, phone, i, variableMappings);
      bodyParams.push({ type: "text", text: val });
    }
    if (bodyParams.some((parameter) => !parameter.text.trim())) {
      await WhatsAppCampaignRecipientModel.updateOne({ _id: recipient._id, status: "sending" }, { $set: { status: "failed", lastError: "A template variable is missing. Map it to contact data before sending." } });
      continue;
    }

    const renderedBody = (template.bodyText || campaign.name).replace(/\{\{(\d+)\}\}/g, (_match, rawIndex: string) =>
      campaignVariableValue(contact, phone, Number(rawIndex), variableMappings),
    );

    const msgPayload = {
      type: "template" as const,
      template: {
        name: template.name,
        language: { code: template.language || "en" },
        ...(bodyParams.length > 0 ? { components: [{ type: "body", parameters: bodyParams }] } : {}),
      },
    };

    try {
      const sendRes = await sendWhatsAppMessage(connection.phoneNumberId, connection.accessToken, phone, msgPayload);

      const conversation = await WhatsAppConversationModel.findOneAndUpdate(
        { ownerId, contactPhone: phone },
        {
          $set: {
            contactName: contact.name || "Customer",
            recipientPhoneNumberId: connection.phoneNumberId,
            recipientDisplayPhone: connection.displayPhoneNumber,
            lastMessageText: renderedBody,
            lastMessageTimestamp: new Date(),
            status: "open",
          },
          $setOnInsert: {
            ownerId,
            contactPhone: phone,
            unreadCount: 0,
            mode: "ai",
            tags: ["Campaign"],
          },
        },
        { upsert: true, new: true },
      );

      await WhatsAppMessageModel.create({
        ownerId,
        conversationId: conversation._id,
        campaignId: campaign._id,
        direction: "outbound",
        senderPhone: connection.displayPhoneNumber || "Campaign",
        recipientPhone: phone,
        type: "template",
        content: renderedBody,
        status: "sent",
        metaMessageId: sendRes.messageId,
      });

      await WhatsAppCampaignRecipientModel.updateOne(
        { _id: recipient._id, status: "sending" },
        { $set: { status: "sent", metaMessageId: sendRes.messageId, lastError: "" } },
      );

      await WhatsAppContactModel.updateOne(
        { _id: contact._id },
        { $set: { lastContactedAt: new Date() } },
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const statusCode = err instanceof HttpError ? err.statusCode : 0;
      // A timeout or provider/server error can mean Meta accepted the message but
      // the response was lost. Never automatically retry that recipient.
      const sendStatus = statusCode >= 500 || statusCode === 0 ? "unknown" : "failed";
      await WhatsAppCampaignRecipientModel.updateOne(
        { _id: recipient._id, status: "sending" },
        { $set: { status: sendStatus, lastError: errorMessage.slice(0, 500) } },
      );
      console.warn(`[WhatsApp Campaign] ${sendStatus} send for ${phone}:`, errorMessage);
    }
  }

  const recipientStats = await WhatsAppCampaignRecipientModel.aggregate([
    { $match: { campaignId: campaign._id } },
    { $group: { _id: null, recipients: { $sum: 1 }, sent: { $sum: { $cond: [{ $in: ["$status", ["sent", "delivered", "read"]] }, 1, 0] } }, failed: { $sum: { $cond: [{ $in: ["$status", ["failed", "unknown"]] }, 1, 0] } }, pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } } } },
  ]);
  const finalStats = recipientStats[0] || { recipients: 0, sent: 0, failed: 0, pending: 0 };
  await WhatsAppCampaignModel.updateOne(
    { _id: campaign._id, leaseId },
    {
      $set: {
        status: finalStats.pending > 0 ? "scheduled" : finalStats.sent > 0 ? "completed" : "failed",
        failureReason: finalStats.pending > 0 ? "Campaign has recipients remaining and will resume automatically." : finalStats.failed > 0 ? "Some recipient sends failed or have an unknown provider outcome; inspect recipient status before retrying." : "",
        senderPhoneNumberId: connection.phoneNumberId,
        senderDisplayPhone: connection.displayPhoneNumber,
        sentAt: new Date(),
        "stats.recipients": finalStats.recipients,
        "stats.sent": finalStats.sent,
        "stats.failed": finalStats.failed,
        leaseId: "",
      },
      $unset: { leaseExpiresAt: 1 },
    },
  );
}

export async function processScheduledWhatsAppCampaigns(limit = 5): Promise<void> {
  if (campaignWorkerRunning) return;
  campaignWorkerRunning = true;
  try {
    const dueCampaigns = await WhatsAppCampaignModel.find({
      $or: [
        { status: "scheduled", scheduledAt: { $lte: new Date() } },
        { status: "running", $or: [{ leaseExpiresAt: { $lte: new Date() } }, { leaseExpiresAt: { $exists: false } }] },
      ],
    })
      .sort({ scheduledAt: 1 })
      .limit(limit);

    for (const campaign of dueCampaigns) {
      await dispatchWhatsAppCampaign(String(campaign._id)).catch((err) => {
        console.warn("[WhatsApp Campaign Worker] Dispatch failed:", err);
      });
    }
  } finally {
    campaignWorkerRunning = false;
  }
}

export async function syncWabaTemplatesForOrg(ownerId: string): Promise<{ synced: number }> {
  const connection = await getConnectedWhatsAppForOrg(ownerId);
  if (!connection?.wabaId) return { synced: 0 };

  const metaTemplates = await listWabaTemplates(connection.wabaId, connection.accessToken);
  let synced = 0;

  for (const mt of metaTemplates) {
    const bodyComp = mt.components?.find((c) => c.type === "BODY");
    const headerComp = mt.components?.find((c) => c.type === "HEADER");
    const footerComp = mt.components?.find((c) => c.type === "FOOTER");
    const buttonsComp = mt.components?.find((c) => c.type === "BUTTONS");

    const mappedCategory = ["MARKETING", "UTILITY", "AUTHENTICATION"].includes(String(mt.category).toUpperCase())
      ? (String(mt.category).toUpperCase() as "MARKETING" | "UTILITY" | "AUTHENTICATION")
      : "UTILITY";

    const mappedStatus = ["APPROVED", "PENDING", "REJECTED"].includes(String(mt.status).toUpperCase())
      ? (String(mt.status).toUpperCase() as "APPROVED" | "PENDING" | "REJECTED")
      : "PENDING";
    const headerFormat = String(headerComp?.format || "").toUpperCase();
    const mappedHeaderType: "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" =
      ["TEXT", "IMAGE", "VIDEO", "DOCUMENT"].includes(headerFormat)
        ? (headerFormat as "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT")
        : "NONE";

    const mappedButtons = Array.isArray(buttonsComp?.buttons)
      ? (buttonsComp.buttons as Array<{ type?: string; text?: string; url?: string; phone_number?: string }>)
          .map((b) => ({
            type: b.type === "URL" ? ("URL" as const) : b.type === "PHONE_NUMBER" ? ("PHONE_NUMBER" as const) : ("QUICK_REPLY" as const),
            text: String(b.text || "Reply"),
            value: String(b.url || b.phone_number || b.text || ""),
          }))
      : [];

    await WhatsAppTemplateModel.findOneAndUpdate(
      { ownerId, name: mt.name },
      {
        $set: {
          category: mappedCategory,
          language: mt.language || "en",
          status: mappedStatus,
          headerType: mappedHeaderType,
          headerText: String(headerComp?.text || ""),
          bodyText: String(bodyComp?.text || mt.name),
          footerText: String(footerComp?.text || ""),
          buttons: mappedButtons,
          metaTemplateId: String(mt.id || ""),
        },
        $setOnInsert: { ownerId, name: mt.name },
      },
      { upsert: true },
    );
    synced += 1;
  }

  return { synced };
}

export async function generateWhatsAppAiReply(input: {
  ownerId: string;
  conversationId?: string;
  contactName: string;
  userMessage: string;
  voiceAgentId?: string;
  welcomeMessage?: string;
  customAgentName?: string;
  customAgentRole?: string;
  systemPrompt?: string;
  knowledgeText?: string;
  language?: string;
  tone?: string;
  allowCallback?: boolean;
  historyOverride?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<string> {
  const [voiceAgent, recentMessages] = await Promise.all([
    input.voiceAgentId
      ? VoiceAgentModel.findOne({ _id: input.voiceAgentId, ownerId: input.ownerId }).select("name prompt firstMessage")
      : VoiceAgentModel.findOne({ ownerId: input.ownerId, status: "Live" }).sort({ updatedAt: -1 }).select("name prompt firstMessage"),
    input.conversationId
      ? WhatsAppMessageModel.find({ conversationId: input.conversationId })
          .sort({ createdAt: -1 })
          .limit(8)
      : Promise.resolve([]),
  ]);

  if (!env.openaiApiKey) {
    const lower = input.userMessage.toLowerCase();
    if (lower.includes("pricing") || lower.includes("price") || lower.includes("cost")) {
      return `Hi ${input.contactName || "there"}! Thanks for asking about pricing. ${input.knowledgeText ? input.knowledgeText.slice(0, 180) : "Our team offers flexible plans tailored to your usage. Would you like a quick walkthrough?"}`;
    }
    if (lower.includes("book") || lower.includes("appointment") || lower.includes("slot")) {
      return "I can help schedule that for you! Please share your preferred day and time, and I will lock in your slot.";
    }
    return input.welcomeMessage || "Hello! How can our team help you today?";
  }

  const history = input.historyOverride
    ? input.historyOverride.slice(-8)
    : recentMessages
        .reverse()
        .map((m) => ({
          role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
          content: m.content,
        }));

  let knowledgeContext = "";
  if (voiceAgent?._id) {
    try {
      const results = await searchKnowledge({
        ownerId: input.ownerId,
        agentId: voiceAgent._id,
        query: input.userMessage,
        limit: 4,
        embeddingTimeoutMs: 2500,
      });
      knowledgeContext = formatKnowledgeContext(results, 3000);
    } catch {
      /* Knowledge search is best-effort */
    }
  }

  const agentDisplayName = input.customAgentName?.trim() || voiceAgent?.name || "Vozon Assistant";
  const agentRoleLine = input.customAgentRole?.trim() ? `Role: ${input.customAgentRole.trim()}.` : "";
  const toneLine = input.tone?.trim() ? `Tone: ${input.tone.trim()}.` : "";
  const langLine = input.language?.trim() ? `Preferred language: ${input.language.trim()} (match customer's language naturally).` : "Match the customer's language if appropriate.";
  const instructions = input.systemPrompt?.trim() || voiceAgent?.prompt?.slice(0, 6000) || "";
  const inlineFacts = input.knowledgeText?.trim() ? `Agent Knowledge / FAQ / Pricing Sheet:\n${input.knowledgeText.trim().slice(0, 4000)}` : "";

  const systemPrompt = [
    `You are "${agentDisplayName}", a concise, helpful WhatsApp Business AI assistant replying to ${input.contactName || "a customer"}. ${agentRoleLine} ${toneLine}`.trim(),
    instructions ? `Agent instructions:\n${instructions.slice(0, 6000)}` : "",
    inlineFacts,
    knowledgeContext ? `Relevant Knowledge Base / Case Playbook Facts:\n${knowledgeContext}` : "",
    "Rules:",
    "- Reply naturally in WhatsApp style (under 90 words, clear and polite, no markdown headers).",
    "- Use the Agent Knowledge & Knowledge Base facts accurately when answering business, pricing, policy, or case questions.",
    `- ${langLine}`,
    input.allowCallback === false
      ? "- Do not offer outbound phone callbacks; resolve everything inside WhatsApp chat."
      : "- If the customer asks to talk on a phone call, reassure them they can reply 'call me' for an instant AI voice callback.",
    "- Never invent prices, URLs, or confirmation numbers you were not given.",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${env.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.3,
        max_tokens: 220,
        messages: [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content: input.userMessage },
        ],
      }),
    });

    const data = (await response.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (response.ok && reply) return reply;
  } catch (err) {
    console.warn("[WhatsApp AI] Reply generation error:", err instanceof Error ? err.message : err);
  }

  return input.welcomeMessage || "Thank you for reaching out! How can we assist you today?";
}

export async function handleWorkspaceRazorpayWebhook(
  ownerId: string,
  rawBody: Buffer,
  signature: string,
): Promise<{ handled: boolean }> {
  const integration = await ProviderIntegrationModel.findOne({
    ownerId,
    provider: "razorpay_api",
    status: "connected",
  }).select("+secretEncrypted");
  if (!integration?.secretEncrypted) {
    throw new HttpError(404, "Razorpay integration is not configured for this workspace.");
  }

  const creds = JSON.parse(decryptSecret(integration.secretEncrypted)) as {
    keyId?: string;
    keySecret?: string;
    webhookSecret?: string;
  };
  const secret = (creds.webhookSecret || creds.keySecret || "").trim();
  if (!secret || !signature) {
    throw new HttpError(401, "Missing Razorpay webhook signature or secret.");
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature.trim(), "utf8");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new HttpError(401, "Invalid Razorpay webhook signature.");
  }

  const event = JSON.parse(rawBody.toString("utf8")) as {
    event?: string;
    payload?: {
      payment_link?: {
        entity?: {
          id?: string;
          amount?: number;
          amount_paid?: number;
          currency?: string;
          short_url?: string;
          notes?: Record<string, string>;
          customer?: { name?: string; contact?: string };
        };
      };
      payment?: {
        entity?: {
          id?: string;
          amount?: number;
          currency?: string;
          contact?: string;
          notes?: Record<string, string>;
        };
      };
    };
  };

  if (event.event !== "payment_link.paid" && event.event !== "payment.captured") {
    return { handled: false };
  }

  const linkEntity = event.payload?.payment_link?.entity;
  const payEntity = event.payload?.payment?.entity;
  const notes = linkEntity?.notes || payEntity?.notes || {};
  const customerPhone = cleanPhoneNumber(
    String(notes.customerPhone || linkEntity?.customer?.contact || payEntity?.contact || ""),
  );
  const customerName = String(notes.customerName || linkEntity?.customer?.name || "Customer");
  const amountMajor = Math.round(((linkEntity?.amount_paid ?? linkEntity?.amount ?? payEntity?.amount ?? 0) as number) / 100);
  const currency = String(linkEntity?.currency || payEntity?.currency || "INR").toUpperCase();

  if (!customerPhone) return { handled: false };

  await WhatsAppContactModel.findOneAndUpdate(
    { ownerId, phoneNumber: customerPhone },
    {
      $set: {
        lastContactedAt: new Date(),
        "customAttributes.crmStage": "Paid",
        "customAttributes.lastPaymentId": String(payEntity?.id || linkEntity?.id || ""),
        "customAttributes.lastPaidAmount": amountMajor,
      },
      $addToSet: { tags: { $each: ["Paid", "Razorpay-Paid"] } },
    },
    { upsert: true },
  );

  void syncLeadToConnectedCrms(ownerId, {
    contactName: customerName,
    contactPhone: customerPhone,
    stage: "Paid",
    tag: "Razorpay-Paid",
    outcome: `Paid ${currency} ${amountMajor}`,
    summary: `Razorpay Payment confirmed (${payEntity?.id || linkEntity?.id || "paid"})`,
  }).catch(() => undefined);

  void notifyConnectedSlack(
    ownerId,
    `✅ *Razorpay Payment Received*: ${customerName} (+${customerPhone}) paid *${currency} ${amountMajor}* via WhatsApp checkout.`,
  ).catch(() => undefined);

  // Immediately update & wake up any Automation Workflow runs waiting for Razorpay payment
  try {
    const phoneVariants = customerPhone.startsWith("+")
      ? [customerPhone, customerPhone.slice(1)]
      : [customerPhone, `+${customerPhone}`];
    const matchClauses: Array<Record<string, unknown>> = [{ contactPhone: { $in: phoneVariants } }];
    if (linkEntity?.id) {
      matchClauses.push({ "context.paymentLinkId": String(linkEntity.id) });
    }
    const paymentUpdate = {
      "context.paymentPaid": true,
      "context.paidAmount": `${currency} ${amountMajor}`,
      "context.lastPaymentId": String(payEntity?.id || linkEntity?.id || ""),
    };

    const woken = await AutomationRunModel.updateMany(
      {
        ownerId,
        status: "waiting",
        waitKind: "payment_paid",
        $or: matchClauses,
      },
      {
        $set: {
          ...paymentUpdate,
          dueAt: new Date(),
        },
      },
    );
    await AutomationRunModel.updateMany(
      {
        ownerId,
        status: { $in: ["queued", "waiting"] },
        waitKind: { $ne: "payment_paid" },
        $or: matchClauses,
      },
      { $set: paymentUpdate },
    );
    if (woken.modifiedCount > 0) {
      void processAutomationRuns().catch(() => undefined);
    }
  } catch (autoErr) {
    console.warn("[Razorpay Webhook] Automation payment wakeup error:", autoErr);
  }

  const connection = await getConnectedWhatsAppForOrg(ownerId);
  if (connection) {
    const receiptText = `✅ Thank you ${customerName}! We have received your payment of *${currency} ${amountMajor}*.\nReference: ${payEntity?.id || linkEntity?.id || "Confirmed"}`;
    try {
      const sendRes = await sendWhatsAppMessage(connection.phoneNumberId, connection.accessToken, customerPhone, {
        type: "text",
        text: receiptText,
      });
      const conv = await WhatsAppConversationModel.findOneAndUpdate(
        { ownerId, contactPhone: customerPhone },
        {
          $set: {
            lastMessageText: receiptText,
            lastMessageTimestamp: new Date(),
          },
          $addToSet: { tags: "Paid" },
        },
        { new: true },
      );
      if (conv) {
        await WhatsAppMessageModel.create({
          ownerId,
          conversationId: conv._id,
          direction: "outbound",
          senderPhone: connection.displayPhoneNumber || "Payment Receipt",
          recipientPhone: customerPhone,
          type: "text",
          content: receiptText,
          status: "delivered",
          metaMessageId: sendRes.messageId,
        });
      }
    } catch {
      /* Non-fatal if WhatsApp session closed */
    }
  }

  return { handled: true };
}

export async function createSupportCaseForContact(input: {
  ownerId: string;
  conversationId?: string;
  contactPhone: string;
  contactName?: string;
  subject: string;
  category?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  notes?: string;
  skipAutomationTrigger?: boolean;
}) {
  const cleanPhone = cleanPhoneNumber(input.contactPhone);
  const existingCount = await WhatsAppSupportCaseModel.countDocuments({ ownerId: input.ownerId });
  const caseNumber = `CASE-${1001 + existingCount}`;

  const supportCase = await WhatsAppSupportCaseModel.create({
    ownerId: input.ownerId,
    caseNumber,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    contactPhone: cleanPhone,
    contactName: (input.contactName || "Customer").trim(),
    subject: input.subject.trim().slice(0, 200) || "Customer Inquiry",
    category: (input.category || "Support").trim(),
    priority: input.priority || "medium",
    status: "open",
    notes: (input.notes || "").trim(),
  });

  await WhatsAppContactModel.findOneAndUpdate(
    { ownerId: input.ownerId, phoneNumber: cleanPhone },
    {
      $set: { "customAttributes.latestCaseNumber": caseNumber, "customAttributes.crmStage": "Case Opened" },
      $addToSet: { tags: { $each: [caseNumber, "Support-Case"] } },
    },
    { upsert: true },
  );

  if (input.conversationId) {
    await WhatsAppConversationModel.updateOne(
      { _id: input.conversationId, ownerId: input.ownerId },
      { $addToSet: { tags: caseNumber } },
    );
  }

  void syncLeadToConnectedCrms(input.ownerId, {
    contactName: input.contactName || "Customer",
    contactPhone: cleanPhone,
    stage: "Case Opened",
    tag: caseNumber,
    outcome: supportCase.category,
    summary: `[${caseNumber}] ${supportCase.subject}`,
  }).catch(() => undefined);

  void notifyConnectedSlack(
    input.ownerId,
    `🎫 *Support Case ${caseNumber} Opened* for ${input.contactName || cleanPhone}\n• *Subject:* ${supportCase.subject}\n• *Category:* ${supportCase.category} | *Priority:* ${supportCase.priority}`,
  ).catch(() => undefined);

  if (!input.skipAutomationTrigger) {
    void triggerCaseAutomations({
      ownerId: input.ownerId,
      event: "case_created",
      supportCase,
    }).catch(() => undefined);
  }

  return supportCase;
}

export async function lookupSupportCasesForPhone(ownerId: string, contactPhone: string, requestedCaseNumber?: string) {
  const cleanPhone = cleanPhoneNumber(contactPhone);
  if (requestedCaseNumber) {
    const exact = await WhatsAppSupportCaseModel.findOne({
      ownerId,
      caseNumber: requestedCaseNumber.toUpperCase(),
      contactPhone: cleanPhone,
    });
    if (exact) return [exact];
  }
  return WhatsAppSupportCaseModel.find({ ownerId, contactPhone: cleanPhone })
    .sort({ createdAt: -1 })
    .limit(3);
}
import { randomUUID } from "node:crypto";
