import { Types } from "mongoose";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { HttpError } from "../utils/httpError.js";
import { cleanPhoneNumber, createWabaTemplate, sendWhatsAppMessage, uploadWhatsAppTemplateHeaderSample } from "../services/whatsappService.js";
import {
  createSupportCaseForContact,
  generateWhatsAppAiReply,
  getConnectedWhatsAppForOrg,
  initiateVoiceCallForWhatsAppContact,
  syncWabaTemplatesForOrg,
} from "../services/whatsappProductionService.js";
import {
  bookConnectedCalendars,
  createRazorpayPaymentLinkForOrg,
  notifyConnectedSlack,
  syncLeadToConnectedCrms,
} from "../services/workflowIntegrationsService.js";
import { handleCaseStatusAutomationUpdate } from "../services/automationRuntimeService.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import {
  WhatsAppContactGroupModel,
  WhatsAppContactModel,
  WhatsAppTemplateModel,
  WhatsAppCampaignModel,
  WhatsAppCampaignRecipientModel,
  WhatsAppConversationModel,
  WhatsAppMessageModel,
  WhatsAppFormModel,
  WhatsAppFormSubmissionModel,
  WhatsAppFlowModel,
  WhatsAppAgentConfigModel,
  WhatsAppCustomAgentModel,
  WhatsAppSupportCaseModel,
} from "../models/WhatsAppEntities.js";

function orgId(request: AuthenticatedRequest): string {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

const getConnectedWhatsApp = getConnectedWhatsAppForOrg;

// ----------------------------------------------------
// 1. WhatsApp Templates
// ----------------------------------------------------
export async function listWhatsAppTemplates(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const templates = await WhatsAppTemplateModel.find({ ownerId }).sort({ createdAt: -1 });
  response.status(200).json({ ok: true, templates });
}

export async function uploadWhatsAppTemplateHeader(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  if (!request.file) throw new HttpError(400, "Choose a sample image, MP4 video, or PDF document.");
  const connection = await getConnectedWhatsAppForOrg(ownerId);
  if (!connection) throw new HttpError(409, "Connect a WhatsApp Business account before uploading template media.");
  const handle = await uploadWhatsAppTemplateHeaderSample(connection.accessToken, request.file);
  response.status(200).json({ ok: true, handle });
}

/* Legacy seed data is intentionally no longer returned for new organizations. */
/*
    const initialTemplates = [
      {
        ownerId,
        name: "appointment_confirmation_v1",
        category: "UTILITY" as const,
        language: "en",
        status: "APPROVED" as const,
        headerType: "TEXT" as const,
        headerText: "Appointment Confirmed",
        bodyText: "Hello {{1}}! Your appointment with {{2}} is confirmed for {{3}} at {{4}}.\n\n📍 Location: {{5}}\nPlease arrive 10 minutes prior.",
        footerText: "Reply STOP to unsubscribe",
        buttons: [
          { type: "QUICK_REPLY" as const, text: "Confirm", value: "CONFIRM" },
          { type: "QUICK_REPLY" as const, text: "Reschedule", value: "RESCHEDULE" },
          { type: "PHONE_NUMBER" as const, text: "Call Support", value: "+918000000000" },
        ],
      },
      {
        ownerId,
        name: "lead_followup_special_offer",
        category: "MARKETING" as const,
        language: "en",
        status: "APPROVED" as const,
        headerType: "TEXT" as const,
        headerText: "Special Offer for You",
        bodyText: "Hi {{1}}, thanks for exploring our voice AI solutions! We've unlocked an exclusive 20% discount on annual plans for your team.",
        footerText: "Valid until this Friday",
        buttons: [
          { type: "URL" as const, text: "Claim Discount", value: "https://vozon.ai/pricing" },
          { type: "QUICK_REPLY" as const, text: "Speak with Expert", value: "TALK_TO_EXPERT" },
        ],
      },
      {
        ownerId,
        name: "secure_otp_verification",
        category: "AUTHENTICATION" as const,
        language: "en",
        status: "APPROVED" as const,
        headerType: "NONE" as const,
        bodyText: "{{1}} is your one-time verification code for Vozon AI. This code expires in 10 minutes. Do not share it with anyone.",
        footerText: "Security Alert",
        buttons: [
          { type: "URL" as const, text: "Copy Code", value: "https://vozon.ai/auth/verify?code={{1}}" },
        ],
      },
      {
        ownerId,
        name: "post_call_summary_notification",
        category: "UTILITY" as const,
        language: "en",
        status: "APPROVED" as const,
        headerType: "TEXT" as const,
        headerText: "Call Follow-up Summary",
        bodyText: "Hi {{1}}, thank you for speaking with our AI voice specialist. Here is a summary of our discussion: {{2}}.\n\nYour next scheduled touchpoint is {{3}}.",
        footerText: "Vozon AI Platform",
        buttons: [
          { type: "URL" as const, text: "View Call Transcript", value: "https://vozon.ai/dashboard/calls" },
        ],
      },
    ];

    await WhatsAppTemplateModel.insertMany(initialTemplates);
    templates = await WhatsAppTemplateModel.find({ ownerId }).sort({ createdAt: -1 });
  }

  response.status(200).json({ ok: true, templates });
*/

export async function createWhatsAppTemplate(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { name, category, language, headerType, headerText, headerMediaUrl, headerMediaHandle, bodyText, footerText, buttons } = request.body;

  if (!name || !bodyText) {
    throw new HttpError(400, "Template name and body text are required.");
  }

  const sanitizedName = String(name).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const normalizedCategory = ["MARKETING", "UTILITY", "AUTHENTICATION"].includes(String(category).toUpperCase())
    ? (String(category).toUpperCase() as "MARKETING" | "UTILITY" | "AUTHENTICATION")
    : "UTILITY";

  let metaStatus: "APPROVED" | "PENDING" | "REJECTED" = "PENDING";
  let metaTemplateId = "";
  const connection = await getConnectedWhatsAppForOrg(ownerId);
  if (!connection?.wabaId) throw new HttpError(409, "Connect a WhatsApp Business account before submitting a template to Meta.");
  if (connection?.wabaId) {
    const metaCreated = await createWabaTemplate(connection.wabaId, connection.accessToken, {
      name: sanitizedName,
      category: normalizedCategory,
      language: language || "en",
      headerType: headerType || "NONE",
      headerText: headerText || "",
      headerMediaHandle: typeof headerMediaHandle === "string" ? headerMediaHandle : "",
      bodyText,
      footerText: footerText || "",
      buttons: Array.isArray(buttons) ? buttons : [],
    });
    metaTemplateId = metaCreated.id;
    metaStatus = metaCreated.status === "APPROVED" ? "APPROVED" : metaCreated.status === "REJECTED" ? "REJECTED" : "PENDING";
  }

  const template = await WhatsAppTemplateModel.create({
    ownerId,
    name: sanitizedName,
    category: normalizedCategory,
    language: language || "en",
    status: metaStatus,
    headerType: headerType || "NONE",
    headerText: headerText || "",
    headerMediaUrl: headerMediaUrl || "",
    bodyText,
    footerText: footerText || "",
    buttons: Array.isArray(buttons) ? buttons : [],
    metaTemplateId,
  });

  response.status(201).json({ ok: true, template });
}

export async function syncWhatsAppTemplates(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { synced } = await syncWabaTemplatesForOrg(ownerId);
  const templates = await WhatsAppTemplateModel.find({ ownerId }).sort({ createdAt: -1 });
  response.status(200).json({ ok: true, synced, templates });
}

export async function deleteWhatsAppTemplate(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { id } = request.params;
  await WhatsAppTemplateModel.findOneAndDelete({ _id: id, ownerId });
  response.status(200).json({ ok: true, message: "Template deleted successfully." });
}

// ----------------------------------------------------
// 2. Contact Groups & Contacts
// ----------------------------------------------------
export async function listWhatsAppContactGroups(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  let groups = await WhatsAppContactGroupModel.find({ ownerId }).sort({ createdAt: -1 });

  if (false && groups.length === 0) {
    const initialGroups = [
      { ownerId, name: "All Leads", description: "Inbound and qualification leads", color: "#118778", contactCount: 24 },
      { ownerId, name: "VIP Healthcare Patients", description: "Priority clinic appointment reminders", color: "#059669", contactCount: 18 },
      { ownerId, name: "Webinar Registrants", description: "Voice AI demo attendees", color: "#3B82F6", contactCount: 42 },
      { ownerId, name: "Follow-up Queue", description: "Leads requiring human callback", color: "#F59E0B", contactCount: 12 },
    ];
    await WhatsAppContactGroupModel.insertMany(initialGroups);
    groups = await WhatsAppContactGroupModel.find({ ownerId }).sort({ createdAt: -1 });

    // Seed sample contacts
    const sampleContacts = [
      { ownerId, groupIds: [groups[0]._id, groups[1]._id], name: "Rajesh Sharma", phoneNumber: "919876543210", email: "rajesh@example.com", tags: ["VIP", "Patient"], status: "subscribed" as const },
      { ownerId, groupIds: [groups[0]._id, groups[2]._id], name: "Pooja Patel", phoneNumber: "919876543211", email: "pooja@example.com", tags: ["Webinar", "Demo"], status: "subscribed" as const },
      { ownerId, groupIds: [groups[0]._id, groups[3]._id], name: "Amit Verma", phoneNumber: "919876543212", email: "amit@example.com", tags: ["Followup", "High-Value"], status: "subscribed" as const },
      { ownerId, groupIds: [groups[1]._id], name: "Ananya Iyer", phoneNumber: "919876543213", email: "ananya@example.com", tags: ["Cardiology"], status: "subscribed" as const },
      { ownerId, groupIds: [groups[2]._id], name: "Kunal Singhania", phoneNumber: "919876543214", email: "kunal@example.com", tags: ["Enterprise"], status: "subscribed" as const },
    ];
    await WhatsAppContactModel.insertMany(sampleContacts);
  }

  // Refresh counts
  for (const group of groups) {
    const count = await WhatsAppContactModel.countDocuments({ ownerId, groupIds: group._id });
    if (group.contactCount !== count) {
      group.contactCount = count;
      await group.save();
    }
  }

  response.status(200).json({ ok: true, groups });
}

export async function createWhatsAppContactGroup(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { name, description, color } = request.body;
  if (!name?.trim()) throw new HttpError(400, "Group name is required.");

  const group = await WhatsAppContactGroupModel.create({
    ownerId,
    name: name.trim(),
    description: description?.trim() || "",
    color: color || "#118778",
  });

  response.status(201).json({ ok: true, group });
}

export async function deleteWhatsAppContactGroup(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { id } = request.params;
  await WhatsAppContactGroupModel.findOneAndDelete({ _id: id, ownerId });
  await WhatsAppContactModel.updateMany({ ownerId, groupIds: id }, { $pull: { groupIds: id } });
  response.status(200).json({ ok: true, message: "Group deleted successfully." });
}

export async function listWhatsAppContacts(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { groupId, search, tag } = request.query;

  const query: Record<string, unknown> = { ownerId };
  if (groupId && typeof groupId === "string") {
    query.groupIds = groupId;
  }
  if (tag && typeof tag === "string") {
    query.tags = tag;
  }
  if (search && typeof search === "string") {
    query.$or = [
      { name: { $regex: search, $options: "i" } },
      { phoneNumber: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
  }

  const contacts = await WhatsAppContactModel.find(query)
    .populate("groupIds", "name color")
    .sort({ createdAt: -1 })
    .limit(100);

  response.status(200).json({ ok: true, contacts });
}

export async function createWhatsAppContact(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { name, phoneNumber, email, groupIds, tags, marketingOptIn } = request.body;

  if (!name || !phoneNumber) {
    throw new HttpError(400, "Name and phone number are required.");
  }

  const cleanPhone = String(phoneNumber).replace(/\D/g, "");
  if (cleanPhone.length < 8 || cleanPhone.length > 15) throw new HttpError(400, "Enter a valid WhatsApp number with its country code.");
  const contact = await WhatsAppContactModel.create({
    ownerId,
    name: name.trim(),
    phoneNumber: cleanPhone,
    email: email?.trim() || "",
    groupIds: Array.isArray(groupIds) ? groupIds : [],
    tags: Array.isArray(tags) ? tags : [],
    status: marketingOptIn === true ? "subscribed" : "pending_consent",
    ...(marketingOptIn === true ? { marketingOptInAt: new Date(), marketingOptInSource: "dashboard_attestation" } : {}),
  });

  response.status(201).json({ ok: true, contact });
}

export async function importWhatsAppContacts(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { contacts, defaultGroupId, optInConfirmed } = request.body;

  if (!Array.isArray(contacts) || contacts.length === 0) {
    throw new HttpError(400, "Contacts list is required for import.");
  }

  const docs = contacts.map((c: Record<string, unknown>) => ({
    ownerId,
    name: String(c.name || "Contact").trim(),
    phoneNumber: String(c.phoneNumber || c.phone || "").replace(/\D/g, ""),
    email: String(c.email || "").trim(),
    groupIds: defaultGroupId ? [defaultGroupId] : [],
    tags: Array.isArray(c.tags) ? c.tags : ["Imported"],
    status: optInConfirmed === true ? "subscribed" as const : "pending_consent" as const,
    ...(optInConfirmed === true ? { marketingOptInAt: new Date(), marketingOptInSource: "bulk_import_attestation" } : {}),
  })).filter((c) => c.phoneNumber.length >= 8 && c.phoneNumber.length <= 15);

  const inserted = await WhatsAppContactModel.insertMany(docs);
  response.status(201).json({ ok: true, count: inserted.length });
}

export async function deleteWhatsAppContact(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { id } = request.params;
  await WhatsAppContactModel.findOneAndDelete({ _id: id, ownerId });
  response.status(200).json({ ok: true, message: "Contact deleted." });
}

// ----------------------------------------------------
// 3. Broadcast Campaigns
// ----------------------------------------------------
export async function listWhatsAppCampaigns(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  let campaigns = await WhatsAppCampaignModel.find({ ownerId }).sort({ createdAt: -1 });

  if (false && campaigns.length === 0) {
    const initialCampaigns = [
      {
        ownerId,
        name: "Diwali Special Health Checkup",
        templateName: "appointment_confirmation_v1",
        groupName: "VIP Healthcare Patients",
        status: "completed" as const,
        sentAt: new Date(Date.now() - 3 * 86400000),
        stats: { recipients: 150, sent: 150, delivered: 147, read: 132, replied: 48, failed: 3 },
      },
      {
        ownerId,
        name: "Voice AI Product Launch Invite",
        templateName: "lead_followup_special_offer",
        groupName: "All Leads",
        status: "completed" as const,
        sentAt: new Date(Date.now() - 7 * 86400000),
        stats: { recipients: 320, sent: 320, delivered: 312, read: 285, replied: 89, failed: 8 },
      },
      {
        ownerId,
        name: "Weekly Patient Follow-up Reminder",
        templateName: "post_call_summary_notification",
        groupName: "Follow-up Queue",
        status: "scheduled" as const,
        scheduledAt: new Date(Date.now() + 86400000),
        stats: { recipients: 45, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 },
      },
    ];
    await WhatsAppCampaignModel.insertMany(initialCampaigns);
    campaigns = await WhatsAppCampaignModel.find({ ownerId }).sort({ createdAt: -1 });
  }

  response.status(200).json({ ok: true, campaigns });
}

export async function createWhatsAppCampaign(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { name, templateId, groupId, scheduleType, scheduledAt, senderPhoneNumberId, variableMappings } = request.body;

  if (!name || !templateId || !groupId) {
    throw new HttpError(400, "Campaign name, template, and contact group are required.");
  }

  const template = await WhatsAppTemplateModel.findOne({ _id: templateId, ownerId });
  const group = await WhatsAppContactGroupModel.findOne({ _id: groupId, ownerId });

  if (!template) throw new HttpError(404, "Template not found.");
  if (!group) throw new HttpError(404, "Contact group not found.");
  if (template.status !== "APPROVED") throw new HttpError(409, "Only templates approved by Meta can be used in a campaign.");
  if (["IMAGE", "VIDEO", "DOCUMENT"].includes(String(template.headerType))) {
    throw new HttpError(409, "Campaign sending for media-header templates is not configured yet. Choose a text or no-header template.");
  }
  const mappingInput = variableMappings && typeof variableMappings === "object" && !Array.isArray(variableMappings)
    ? variableMappings as Record<string, unknown>
    : {};
  const maxVariable = Math.max(0, ...Array.from(template.bodyText.matchAll(/\{\{(\d+)\}\}/g), (match) => Number(match[1])));
  const resolvedMappings: Record<string, string> = {};
  for (let index = 1; index <= maxVariable; index += 1) {
    const mapping = String(mappingInput[String(index)] || (index === 1 ? "name" : index === 2 ? "phone" : index === 3 ? "email" : "")).trim();
    if (!/^(name|phone|email|attribute:[a-zA-Z0-9_.-]{1,80}|static:.{1,500})$/.test(mapping)) {
      throw new HttpError(400, `Map template variable {{${index}}} to a contact field or enter a static value before scheduling.`);
    }
    resolvedMappings[String(index)] = mapping;
  }

  const recipientPhones = await WhatsAppContactModel.distinct("phoneNumber", {
    ownerId,
    groupIds: groupId,
    status: "subscribed",
    marketingOptInAt: { $exists: true },
  });
  const recipientCount = new Set(recipientPhones.map((phone) => cleanPhoneNumber(String(phone)))).size;
  if (recipientCount === 0) throw new HttpError(409, "This contact group has no contacts with recorded WhatsApp marketing consent. Confirm opt-in when adding or importing contacts first.");

  const isInstant = scheduleType === "now";
  if (!isInstant && (!scheduledAt || !Number.isFinite(Date.parse(scheduledAt)) || Date.parse(scheduledAt) <= Date.now())) {
    throw new HttpError(400, "Choose a valid future date and time for a scheduled campaign.");
  }
  const connection = await getConnectedWhatsAppForOrg(ownerId, senderPhoneNumberId);
  if (!connection) throw new HttpError(409, "Connect the selected WhatsApp Business number before scheduling a campaign.");
  if (senderPhoneNumberId && connection.phoneNumberId !== senderPhoneNumberId) {
    throw new HttpError(404, "The selected WhatsApp Business number is not connected to this workspace.");
  }

  const campaign = await WhatsAppCampaignModel.create({
    ownerId,
    name: name.trim(),
    templateId,
    templateName: template.name,
    groupId,
    groupName: group.name,
    senderPhoneNumberId: connection?.phoneNumberId || senderPhoneNumberId || "",
    senderDisplayPhone: connection?.displayPhoneNumber || "",
    variableMappings: resolvedMappings,
    status: "scheduled",
    scheduledAt: isInstant ? new Date() : new Date(scheduledAt),
    stats: {
      recipients: recipientCount,
      sent: 0,
      delivered: 0,
      read: 0,
      replied: 0,
      failed: 0,
    },
  });

  response.status(201).json({ ok: true, campaign });
}

export async function deleteWhatsAppCampaign(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { id } = request.params;
  const deletedCampaign = await WhatsAppCampaignModel.findOneAndDelete({ _id: id, ownerId, status: { $ne: "running" } });
  if (!deletedCampaign) throw new HttpError(409, "A running campaign cannot be deleted while messages are being sent.");
  await WhatsAppCampaignRecipientModel.deleteMany({ campaignId: id, ownerId });
  response.status(200).json({ ok: true, message: "Campaign deleted." });
}

// ----------------------------------------------------
// 4. WhatsApp AI Agent Configuration
// ----------------------------------------------------
export async function getWhatsAppAgentConfig(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  let config = await WhatsAppAgentConfigModel.findOne({ ownerId });

  if (!config) {
    config = await WhatsAppAgentConfigModel.create({
      ownerId,
      name: "Vozon WhatsApp Assistant",
      enabled: true,
      autoReply: true,
      welcomeMessage: "👋 Welcome to Vozon AI! How can our intelligent assistant help you today?",
      fallbackMessage: "I'm passing your conversation to a live care specialist. They'll be with you shortly.",
      transferKeywords: ["agent", "human", "representative", "help", "doctor"],
      businessHoursOnly: false,
    });
  }

  response.status(200).json({ ok: true, config });
}

export async function updateWhatsAppAgentConfig(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const raw = (request.body && typeof request.body === "object") ? (request.body as Record<string, unknown>) : {};
  const updates: Record<string, unknown> = { ...raw };

  if (Array.isArray(raw.adminDispatchPhones)) {
    updates.adminDispatchPhones = Array.from(
      new Set(
        raw.adminDispatchPhones
          .map((p) => String(p ?? "").replace(/\D/g, ""))
          .map((d) => (d.length === 10 ? `91${d}` : d))
          .filter((d) => d.length >= 8 && d.length <= 15),
      ),
    ).slice(0, 25);
  }
  if (raw.adminDispatchMaxBatch !== undefined) {
    const cap = Number(raw.adminDispatchMaxBatch);
    updates.adminDispatchMaxBatch = Number.isFinite(cap) ? Math.min(500, Math.max(1, Math.round(cap))) : 200;
  }

  const config = await WhatsAppAgentConfigModel.findOneAndUpdate(
    { ownerId },
    { $set: updates },
    { new: true, upsert: true },
  );

  response.status(200).json({ ok: true, config });
}

// ----------------------------------------------------
// 4b. Multi-Agent WhatsApp Custom AI Agents CRUD + Live Simulator
// ----------------------------------------------------
function sanitizeStringList(input: unknown, max = 30): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  ).slice(0, max);
}

type SanitizedHandoffRule = {
  targetAgentId: string;
  targetAgentName: string;
  keywords: string[];
  condition: string;
  announceMessage: string;
};

function sanitizeHandoffRules(input: unknown, selfId?: string): SanitizedHandoffRule[] {
  if (!Array.isArray(input)) return [];
  const rules: SanitizedHandoffRule[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const targetAgentId = String(obj.targetAgentId ?? "").trim();
    if (!targetAgentId || (selfId && targetAgentId === selfId)) continue;
    const rawKeywords = Array.isArray(obj.keywords)
      ? obj.keywords
      : typeof obj.keywords === "string"
        ? obj.keywords.split(",")
        : [];
    const keywords = sanitizeStringList(rawKeywords, 20);
    const condition = String(obj.condition ?? "").trim().slice(0, 240);
    const announceMessage = String(obj.announceMessage ?? "").trim().slice(0, 400);
    const targetAgentName = String(obj.targetAgentName ?? "").trim().slice(0, 80);
    if (!keywords.length && !condition) continue;
    rules.push({ targetAgentId, targetAgentName, keywords, condition, announceMessage });
    if (rules.length >= 15) break;
  }
  return rules;
}

export function matchAgentHandoffRule<
  T extends { targetAgentId: string; keywords?: string[]; condition?: string; announceMessage?: string; targetAgentName?: string },
>(rules: T[] | undefined, messageText: string): T | null {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const lower = messageText.toLowerCase();
  for (const rule of rules) {
    const kws = (rule.keywords || []).map((k) => String(k || "").trim().toLowerCase()).filter(Boolean);
    if (kws.some((kw) => lower.includes(kw))) {
      return rule;
    }
    const condWords = String(rule.condition || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !["when", "user", "asks", "about", "wants", "customer", "transfer", "handoff", "agent"].includes(w));
    if (condWords.length > 0 && condWords.some((w) => lower.includes(w))) {
      return rule;
    }
  }
  return null;
}

export async function listWhatsAppCustomAgents(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  let agents = await WhatsAppCustomAgentModel.find({ ownerId }).sort({ isDefault: -1, createdAt: 1 });

  // Seamlessly migrate existing single-agent workspace config into a starter custom agent
  if (agents.length === 0) {
    const legacy = await WhatsAppAgentConfigModel.findOne({ ownerId });
    const starter = await WhatsAppCustomAgentModel.create({
      ownerId,
      name: legacy?.name || "Vozon WhatsApp Assistant",
      role: "General",
      status: legacy?.enabled === false ? "paused" : "live",
      isDefault: true,
      language: "English + Hinglish",
      tone: "friendly",
      welcomeMessage:
        legacy?.welcomeMessage || "👋 Welcome to Vozon AI! How can our intelligent assistant help you today?",
      systemPrompt:
        "You are a friendly, helpful WhatsApp Business AI assistant. Answer customer questions clearly, qualify leads politely, and offer to book an appointment or arrange a voice callback if they prefer speaking on the phone.",
      knowledgeText: "",
      voiceAgentId: legacy?.voiceAgentId || "",
      autoReply: legacy?.autoReply ?? true,
      allowCallback: true,
      triggerKeywords: [],
      transferKeywords:
        legacy?.transferKeywords?.length
          ? legacy.transferKeywords
          : ["agent", "human", "representative", "help"],
      fallbackMessage:
        legacy?.fallbackMessage || "I'm passing your conversation to a live specialist. They'll be with you shortly.",
    });
    agents = [starter];
  }

  response.status(200).json({ ok: true, agents });
}

export async function createWhatsAppCustomAgent(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const body = (request.body && typeof request.body === "object") ? (request.body as Record<string, unknown>) : {};
  const name = String(body.name ?? "").trim();
  if (!name) {
    throw new HttpError(400, "Agent name is required.");
  }

  const existingCount = await WhatsAppCustomAgentModel.countDocuments({ ownerId });
  const isDefault = existingCount === 0 ? true : Boolean(body.isDefault);
  if (isDefault) {
    await WhatsAppCustomAgentModel.updateMany({ ownerId }, { $set: { isDefault: false } });
  }

  const allowedStatus = ["live", "draft", "paused"];
  const allowedTone = ["friendly", "professional", "concise", "consultative"];
  const status = allowedStatus.includes(String(body.status)) ? String(body.status) : "live";
  const tone = allowedTone.includes(String(body.tone)) ? String(body.tone) : "friendly";

  const agent = await WhatsAppCustomAgentModel.create({
    ownerId,
    name: name.slice(0, 80),
    role: String(body.role ?? "Sales").trim().slice(0, 40) || "Sales",
    status,
    isDefault,
    phoneNumberId: String(body.phoneNumberId ?? "").trim(),
    displayPhoneNumber: String(body.displayPhoneNumber ?? "").trim(),
    language: String(body.language ?? "English + Hinglish").trim().slice(0, 60),
    tone,
    welcomeMessage: String(body.welcomeMessage ?? "👋 Welcome! How can I help you today?").trim().slice(0, 1000),
    systemPrompt: String(
      body.systemPrompt ?? "You are a helpful WhatsApp Business AI assistant. Answer clearly and concisely.",
    )
      .trim()
      .slice(0, 8000),
    knowledgeText: String(body.knowledgeText ?? "").trim().slice(0, 8000),
    voiceAgentId: String(body.voiceAgentId ?? "").trim(),
    autoReply: body.autoReply !== false,
    allowCallback: body.allowCallback !== false,
    triggerKeywords: sanitizeStringList(body.triggerKeywords, 25),
    handoffRules: sanitizeHandoffRules(body.handoffRules),
    transferKeywords:
      Array.isArray(body.transferKeywords)
        ? sanitizeStringList(body.transferKeywords, 25)
        : ["agent", "human", "representative", "help"],
    fallbackMessage: String(
      body.fallbackMessage ?? "I'm passing your conversation to a live specialist. They'll be with you shortly.",
    )
      .trim()
      .slice(0, 1000),
  });

  response.status(201).json({ ok: true, agent });
}

export async function updateWhatsAppCustomAgent(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { id } = request.params;
  if (!Types.ObjectId.isValid(id)) {
    throw new HttpError(400, "Invalid WhatsApp agent id.");
  }

  const body = (request.body && typeof request.body === "object") ? (request.body as Record<string, unknown>) : {};
  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw new HttpError(400, "Agent name cannot be empty.");
    updates.name = name.slice(0, 80);
  }
  if (body.role !== undefined) updates.role = String(body.role).trim().slice(0, 40) || "Custom";
  if (body.status !== undefined && ["live", "draft", "paused"].includes(String(body.status))) {
    updates.status = String(body.status);
  }
  if (body.tone !== undefined && ["friendly", "professional", "concise", "consultative"].includes(String(body.tone))) {
    updates.tone = String(body.tone);
  }
  if (body.phoneNumberId !== undefined) updates.phoneNumberId = String(body.phoneNumberId).trim();
  if (body.displayPhoneNumber !== undefined) updates.displayPhoneNumber = String(body.displayPhoneNumber).trim();
  if (body.language !== undefined) updates.language = String(body.language).trim().slice(0, 60);
  if (body.welcomeMessage !== undefined) updates.welcomeMessage = String(body.welcomeMessage).trim().slice(0, 1000);
  if (body.systemPrompt !== undefined) updates.systemPrompt = String(body.systemPrompt).trim().slice(0, 8000);
  if (body.knowledgeText !== undefined) updates.knowledgeText = String(body.knowledgeText).trim().slice(0, 8000);
  if (body.voiceAgentId !== undefined) updates.voiceAgentId = String(body.voiceAgentId).trim();
  if (body.autoReply !== undefined) updates.autoReply = Boolean(body.autoReply);
  if (body.allowCallback !== undefined) updates.allowCallback = Boolean(body.allowCallback);
  if (body.triggerKeywords !== undefined) updates.triggerKeywords = sanitizeStringList(body.triggerKeywords, 25);
  if (body.handoffRules !== undefined) updates.handoffRules = sanitizeHandoffRules(body.handoffRules, id);
  if (body.transferKeywords !== undefined) updates.transferKeywords = sanitizeStringList(body.transferKeywords, 25);
  if (body.fallbackMessage !== undefined) updates.fallbackMessage = String(body.fallbackMessage).trim().slice(0, 1000);

  if (body.isDefault === true) {
    await WhatsAppCustomAgentModel.updateMany({ ownerId, _id: { $ne: id } }, { $set: { isDefault: false } });
    updates.isDefault = true;
  } else if (body.isDefault === false) {
    updates.isDefault = false;
  }

  const agent = await WhatsAppCustomAgentModel.findOneAndUpdate(
    { _id: id, ownerId },
    { $set: updates },
    { new: true },
  );
  if (!agent) {
    throw new HttpError(404, "WhatsApp agent not found.");
  }

  response.status(200).json({ ok: true, agent });
}

export async function deleteWhatsAppCustomAgent(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { id } = request.params;
  if (!Types.ObjectId.isValid(id)) {
    throw new HttpError(400, "Invalid WhatsApp agent id.");
  }

  const deleted = await WhatsAppCustomAgentModel.findOneAndDelete({ _id: id, ownerId });
  if (!deleted) {
    throw new HttpError(404, "WhatsApp agent not found.");
  }

  if (deleted.isDefault) {
    const nextDefault = await WhatsAppCustomAgentModel.findOne({ ownerId }).sort({ createdAt: 1 });
    if (nextDefault) {
      nextDefault.isDefault = true;
      await nextDefault.save();
    }
  }

  // Remove any agent-to-agent handoff rules referencing the deleted agent
  await WhatsAppCustomAgentModel.updateMany(
    { ownerId, "handoffRules.targetAgentId": id },
    { $pull: { handoffRules: { targetAgentId: id } } },
  );

  response.status(200).json({ ok: true, message: "WhatsApp agent deleted." });
}

export async function simulateWhatsAppCustomAgent(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { id } = request.params;
  const body = (request.body && typeof request.body === "object") ? (request.body as Record<string, unknown>) : {};
  const message = String(body.message ?? "").trim();
  if (!message) {
    throw new HttpError(400, "Simulation message is required.");
  }

  const savedAgent = Types.ObjectId.isValid(id)
    ? await WhatsAppCustomAgentModel.findOne({ _id: id, ownerId })
    : null;

  // Allow unsaved draft overrides from the studio editor for instant testing
  const draft = (body.draft && typeof body.draft === "object") ? (body.draft as Record<string, unknown>) : {};

  // Check Agent-to-Agent Handoff Connections FIRST
  const effectiveRules = Array.isArray(draft.handoffRules)
    ? sanitizeHandoffRules(draft.handoffRules, id)
    : (savedAgent?.handoffRules || []);
  const matchedHandoff = matchAgentHandoffRule(effectiveRules, message);
  const targetAgent =
    matchedHandoff && Types.ObjectId.isValid(matchedHandoff.targetAgentId)
      ? await WhatsAppCustomAgentModel.findOne({ _id: matchedHandoff.targetAgentId, ownerId })
      : null;

  const respondingAgent = targetAgent || savedAgent;
  const useDraft = !targetAgent;

  const transferKeywords = useDraft && Array.isArray(draft.transferKeywords)
    ? sanitizeStringList(draft.transferKeywords, 25)
    : respondingAgent?.transferKeywords || ["agent", "human", "help"];
  const fallbackMessage =
    useDraft && typeof draft.fallbackMessage === "string"
      ? draft.fallbackMessage
      : respondingAgent?.fallbackMessage || "Connecting you with a human teammate.";
  const lower = message.toLowerCase();

  if (!targetAgent && transferKeywords.some((kw) => kw && lower.includes(kw.toLowerCase()))) {
    response.status(200).json({
      ok: true,
      reply: fallbackMessage,
      tag: "Human Handover",
    });
    return;
  }

  const rawHistory = Array.isArray(body.history)
    ? body.history
        .map((m) => {
          const item = m as Record<string, unknown>;
          const role = item.role === "assistant" ? ("assistant" as const) : ("user" as const);
          return { role, content: String(item.content ?? "").slice(0, 600) };
        })
        .filter((m) => m.content.trim().length > 0)
        .slice(-8)
    : [];

  const reply = await generateWhatsAppAiReply({
    ownerId,
    contactName: String(body.contactName ?? "Test Customer"),
    userMessage: message,
    voiceAgentId:
      useDraft && typeof draft.voiceAgentId === "string"
        ? draft.voiceAgentId
        : respondingAgent?.voiceAgentId,
    welcomeMessage:
      useDraft && typeof draft.welcomeMessage === "string"
        ? draft.welcomeMessage
        : respondingAgent?.welcomeMessage,
    customAgentName:
      useDraft && typeof draft.name === "string" ? draft.name : respondingAgent?.name,
    customAgentRole:
      useDraft && typeof draft.role === "string" ? draft.role : respondingAgent?.role,
    systemPrompt:
      useDraft && typeof draft.systemPrompt === "string"
        ? draft.systemPrompt
        : respondingAgent?.systemPrompt,
    knowledgeText:
      useDraft && typeof draft.knowledgeText === "string"
        ? draft.knowledgeText
        : respondingAgent?.knowledgeText,
    language:
      useDraft && typeof draft.language === "string" ? draft.language : respondingAgent?.language,
    tone:
      useDraft && typeof draft.tone === "string" ? draft.tone : respondingAgent?.tone,
    allowCallback:
      useDraft && typeof draft.allowCallback === "boolean"
        ? draft.allowCallback
        : respondingAgent?.allowCallback,
    historyOverride: rawHistory,
  });

  const combinedReply =
    targetAgent && matchedHandoff?.announceMessage
      ? `${matchedHandoff.announceMessage}\n\n${reply}`
      : reply;

  response.status(200).json({
    ok: true,
    reply: combinedReply,
    tag: targetAgent ? `Handoff → ${targetAgent.name}` : "Live AI Reply",
    handedOffToAgentId: targetAgent ? String(targetAgent._id) : undefined,
    handedOffToAgentName: targetAgent ? targetAgent.name : undefined,
  });
}

// ----------------------------------------------------
// 5. Live Chat (2-Way Conversations & Messaging)
// ----------------------------------------------------
export async function listWhatsAppConversations(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  // Remove the legacy demo rows created by older versions of this endpoint.
  // Match the full seed identity and unchanged preview text so customer data
  // can never be mistaken for one of those fixtures.
  const legacyDemoRows = [
    { contactPhone: "919876543210", contactName: "Rajesh Sharma", lastMessageText: "Yes, I'd like to confirm tomorrow's appointment at 11:30 AM." },
    { contactPhone: "919876543211", contactName: "Pooja Patel", lastMessageText: "Can someone call me regarding the enterprise voice bot pricing?" },
    { contactPhone: "919876543212", contactName: "Amit Verma", lastMessageText: "Thanks, the prescription details are received." },
  ];
  for (const demo of legacyDemoRows) {
    const legacyConversation = await WhatsAppConversationModel.findOne({ ownerId, ...demo }).select("_id");
    if (!legacyConversation) continue;
    await WhatsAppMessageModel.deleteMany({
      ownerId,
      conversationId: legacyConversation._id,
      content: { $in: [
        "Hello Rajesh! Your appointment is scheduled for tomorrow at 11:30 AM. Reply to confirm.",
        "Yes, I'd like to confirm tomorrow's appointment at 11:30 AM.",
      ] },
    });
    await WhatsAppConversationModel.deleteOne({ _id: legacyConversation._id, ownerId });
  }

  const conversations = await WhatsAppConversationModel.find({ ownerId }).sort({ lastMessageTimestamp: -1 });
  response.status(200).json({ ok: true, conversations });
}

export async function getWhatsAppMessages(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { conversationId } = request.params;

  const messages = await WhatsAppMessageModel.find({
    ownerId,
    conversationId,
  }).sort({ createdAt: 1 });

  // Reset unread count
  await WhatsAppConversationModel.findByIdAndUpdate(conversationId, { unreadCount: 0 });

  response.status(200).json({ ok: true, messages });
}

export async function sendWhatsAppChatMessage(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { conversationId } = request.params;
  const { content, type, fromPhoneNumberId, mediaUrl, filename } = request.body as {
    content?: string;
    type?: "text" | "image" | "document";
    fromPhoneNumberId?: string;
    mediaUrl?: string;
    filename?: string;
  };

  const trimmedContent = content?.trim() || "";
  const trimmedMediaUrl = mediaUrl?.trim() || "";
  const msgType = type === "image" || type === "document" ? type : "text";
  if (!trimmedContent && !trimmedMediaUrl) {
    throw new HttpError(400, "Message content or media URL is required.");
  }

  const conversation = await WhatsAppConversationModel.findOne({ _id: conversationId, ownerId });
  if (!conversation) throw new HttpError(404, "Conversation not found.");

  const preferredNumberId = fromPhoneNumberId || conversation.recipientPhoneNumberId;
  const connection = await getConnectedWhatsApp(ownerId, preferredNumberId);
  if (!connection) {
    throw new HttpError(400, "WhatsApp is not connected for this organization. Connect a WhatsApp number before sending messages.");
  }

  const sendPayload =
    msgType === "image" && trimmedMediaUrl
      ? { type: "image" as const, image: { link: trimmedMediaUrl, ...(trimmedContent ? { caption: trimmedContent } : {}) } }
      : msgType === "document" && trimmedMediaUrl
        ? {
            type: "document" as const,
            document: {
              link: trimmedMediaUrl,
              ...(trimmedContent ? { caption: trimmedContent } : {}),
              ...(filename?.trim() ? { filename: filename.trim() } : { filename: "document.pdf" }),
            },
          }
        : { type: "text" as const, text: trimmedContent };
  const res = await sendWhatsAppMessage(connection.phoneNumberId, connection.accessToken, conversation.contactPhone, sendPayload);

  const storedContent = trimmedMediaUrl
    ? `${msgType === "image" ? "🖼️ Image" : `📄 ${filename?.trim() || "Document"}`}: ${trimmedMediaUrl}${trimmedContent ? `\n${trimmedContent}` : ""}`
    : trimmedContent;

  const message = await WhatsAppMessageModel.create({
    ownerId,
    conversationId,
    direction: "outbound",
    senderPhone: "Agent",
    recipientPhone: conversation.contactPhone,
    type: msgType,
    content: storedContent,
    status: "sent",
    metaMessageId: res.messageId,
  });

  conversation.lastMessageText = storedContent;
  conversation.lastMessageTimestamp = new Date();
  await conversation.save();

  response.status(201).json({ ok: true, message });
}

export async function toggleWhatsAppConversationMode(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { conversationId } = request.params;
  const { mode } = request.body;

  const conversation = await WhatsAppConversationModel.findOneAndUpdate(
    { _id: conversationId, ownerId },
    { $set: { mode: mode === "human" ? "human" : "ai" } },
    { new: true },
  );

  response.status(200).json({ ok: true, conversation });
}

export async function triggerWhatsAppConversationIntegration(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { conversationId } = request.params;
  const { action, amount, currency, description, title, stage } = request.body as {
    action?: "razorpay_payment_link" | "calendar_booking" | "crm_sync" | "slack_alert";
    amount?: number;
    currency?: string;
    description?: string;
    title?: string;
    stage?: string;
  };

  const conversation = await WhatsAppConversationModel.findOne({ _id: conversationId, ownerId });
  if (!conversation) throw new HttpError(404, "Conversation not found.");

  let outboundText = "";
  let summary = "";

  if (action === "razorpay_payment_link") {
    const payAmount = Number(amount || 999);
    const payCurrency = (currency || "INR").toUpperCase();
    const link = await createRazorpayPaymentLinkForOrg(ownerId, {
      amount: payAmount,
      currency: payCurrency,
      description: description || "Payment Request",
      customerName: conversation.contactName || "Customer",
      customerPhone: conversation.contactPhone,
      referenceId: String(conversation._id),
    });
    outboundText = `Hi ${conversation.contactName || "there"}! 💳 Here is your secure Razorpay payment link for *${payCurrency} ${payAmount.toLocaleString("en-IN")}*:\n\n${link.shortUrl}`;
    summary = `Razorpay Payment Link created (${link.shortUrl})`;
  } else if (action === "calendar_booking") {
    const cal = await bookConnectedCalendars(ownerId, {
      title: title || "Consultation Call",
      durationMinutes: 30,
      customerName: conversation.contactName || "Customer",
      customerPhone: conversation.contactPhone,
    });
    const bookingUrl = cal.calendlyLink || cal.calendarHtmlLink || "";
    outboundText = bookingUrl
      ? `Hi ${conversation.contactName || "there"}! 📅 Here is your booking link for *${title || "Consultation Call"}*:\n\n${bookingUrl}`
      : `Hi ${conversation.contactName || "there"}! 📅 Your *${title || "Consultation Call"}* has been scheduled for ${new Date(cal.scheduledStartIso).toLocaleString()}.`;
    summary = cal.syncedProviders.length
      ? `Calendar synced (${cal.syncedProviders.join(", ")})`
      : "Appointment scheduled";
  } else if (action === "crm_sync") {
    const crm = await syncLeadToConnectedCrms(ownerId, {
      contactName: conversation.contactName || "Customer",
      contactPhone: conversation.contactPhone,
      stage: stage || "Qualified",
      tag: "WhatsApp-LiveChat",
      summary: conversation.lastMessageText,
    });
    summary = crm.syncedProviders.length
      ? `Synced to ${crm.syncedProviders.join(", ")}`
      : "Saved to Vozon CRM (connect HubSpot/Zoho/Salesforce/HighLevel/Google Sheets in Integrations for external sync)";
  } else if (action === "slack_alert") {
    const ok = await notifyConnectedSlack(
      ownerId,
      `💬 *WhatsApp Alert*: ${conversation.contactName || conversation.contactPhone} — "${conversation.lastMessageText}"`,
    );
    if (!ok) throw new HttpError(409, "Connect Slack in Integrations first.");
    summary = "Slack alert delivered.";
  } else {
    throw new HttpError(400, "Unsupported integration action.");
  }

  let createdMessage = null;
  if (outboundText) {
    let metaMessageId = "";
    const connection = await getConnectedWhatsApp(ownerId, conversation.recipientPhoneNumberId);
    if (connection) {
      try {
        const res = await sendWhatsAppMessage(connection.phoneNumberId, connection.accessToken, conversation.contactPhone, {
          type: "text",
          text: outboundText,
        });
        metaMessageId = res.messageId;
      } catch (err) {
        console.warn("Could not dispatch integration message to WhatsApp:", err);
      }
    }
    createdMessage = await WhatsAppMessageModel.create({
      ownerId,
      conversationId,
      direction: "outbound",
      senderPhone: "Agent",
      recipientPhone: conversation.contactPhone,
      type: "text",
      content: outboundText,
      status: metaMessageId ? "delivered" : "sent",
      metaMessageId,
    });
    conversation.lastMessageText = outboundText;
    conversation.lastMessageTimestamp = new Date();
    await conversation.save();
  }

  response.status(200).json({ ok: true, summary, message: createdMessage });
}

export async function callWhatsAppConversationContact(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { conversationId } = request.params;
  const { voiceAgentId } = (request.body || {}) as { voiceAgentId?: string };

  const conversation = await WhatsAppConversationModel.findOne({ _id: conversationId, ownerId });
  if (!conversation) throw new HttpError(404, "Conversation not found.");

  const callResult = await initiateVoiceCallForWhatsAppContact(ownerId, {
    contactPhone: conversation.contactPhone,
    contactName: conversation.contactName,
    voiceAgentId,
    conversationId: String(conversation._id),
  });

  const summaryMsg = `📞 Outbound AI Voice Call initiated via ${callResult.agentName} (${callResult.fromNumber}) — Call ID: ${callResult.callId}`;
  const loggedMessage = await WhatsAppMessageModel.create({
    ownerId,
    conversationId,
    direction: "outbound",
    senderPhone: "Voice AI Agent",
    recipientPhone: conversation.contactPhone,
    type: "text",
    content: summaryMsg,
    status: "sent",
  });
  conversation.lastMessageText = summaryMsg;
  conversation.lastMessageTimestamp = new Date();
  await conversation.save();

  response.status(200).json({
    ok: true,
    callId: callResult.callId,
    agentName: callResult.agentName,
    fromNumber: callResult.fromNumber,
    message: loggedMessage,
  });
}

export async function listWhatsAppConversationCases(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { conversationId } = request.params;
  const conversation = await WhatsAppConversationModel.findOne({ _id: conversationId, ownerId });
  if (!conversation) throw new HttpError(404, "Conversation not found.");

  const cases = await WhatsAppSupportCaseModel.find({
    ownerId,
    contactPhone: conversation.contactPhone,
  }).sort({ createdAt: -1 });

  response.status(200).json({ ok: true, cases });
}

export async function createWhatsAppConversationCase(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { conversationId } = request.params;
  const { subject, category, priority, notifyCustomer } = (request.body || {}) as {
    subject?: string;
    category?: string;
    priority?: "low" | "medium" | "high" | "urgent";
    notifyCustomer?: boolean;
  };

  const conversation = await WhatsAppConversationModel.findOne({ _id: conversationId, ownerId });
  if (!conversation) throw new HttpError(404, "Conversation not found.");

  const supportCase = await createSupportCaseForContact({
    ownerId,
    conversationId: String(conversation._id),
    contactPhone: conversation.contactPhone,
    contactName: conversation.contactName,
    subject: subject?.trim() || conversation.lastMessageText || "Customer Support Request",
    category: category?.trim() || "Support",
    priority: priority || "medium",
  });

  let createdMessage = null;
  if (notifyCustomer !== false) {
    const noticeText = `🎫 Support Case Created: *${supportCase.caseNumber}*\nSubject: ${supportCase.subject}\nStatus: Open — Reply "${supportCase.caseNumber}" anytime to check your case progress.`;
    let metaMessageId = "";
    const connection = await getConnectedWhatsApp(ownerId, conversation.recipientPhoneNumberId);
    if (connection) {
      try {
        const res = await sendWhatsAppMessage(connection.phoneNumberId, connection.accessToken, conversation.contactPhone, {
          type: "text",
          text: noticeText,
        });
        metaMessageId = res.messageId;
      } catch {
        /* Non-fatal if out of session window */
      }
    }
    createdMessage = await WhatsAppMessageModel.create({
      ownerId,
      conversationId,
      direction: "outbound",
      senderPhone: "Support Desk",
      recipientPhone: conversation.contactPhone,
      type: "text",
      content: noticeText,
      status: metaMessageId ? "delivered" : "sent",
      metaMessageId,
    });
    conversation.lastMessageText = noticeText;
    conversation.lastMessageTimestamp = new Date();
    await conversation.save();
  }

  response.status(201).json({ ok: true, supportCase, message: createdMessage });
}

export async function updateWhatsAppSupportCaseStatus(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { caseId } = request.params;
  const { status, notifyCustomer } = (request.body || {}) as {
    status?: "open" | "in_progress" | "resolved";
    notifyCustomer?: boolean;
  };

  if (!status || !["open", "in_progress", "resolved"].includes(status)) {
    throw new HttpError(400, "Valid case status (open, in_progress, resolved) is required.");
  }

  const supportCase = await WhatsAppSupportCaseModel.findOneAndUpdate(
    { _id: caseId, ownerId },
    { $set: { status } },
    { new: true },
  );
  if (!supportCase) throw new HttpError(404, "Support case not found.");

  void syncLeadToConnectedCrms(ownerId, {
    contactName: supportCase.contactName || "Customer",
    contactPhone: supportCase.contactPhone,
    stage: status === "resolved" ? "Case Resolved" : "Case In Progress",
    tag: supportCase.caseNumber,
    summary: `[${supportCase.caseNumber}] Updated to ${status}`,
  }).catch(() => undefined);

  void handleCaseStatusAutomationUpdate({
    ownerId,
    supportCase,
  }).catch(() => undefined);

  let createdMessage = null;
  if (notifyCustomer !== false && supportCase.conversationId) {
    const label = status === "resolved" ? "Resolved ✅" : status === "in_progress" ? "In Progress 🔧" : "Open 🎫";
    const noticeText = `Update on *${supportCase.caseNumber}* (${supportCase.subject}):\nStatus is now *${label}*.`;
    const conversation = await WhatsAppConversationModel.findOne({ _id: supportCase.conversationId, ownerId });
    if (conversation) {
      let metaMessageId = "";
      const connection = await getConnectedWhatsApp(ownerId, conversation.recipientPhoneNumberId);
      if (connection) {
        try {
          const res = await sendWhatsAppMessage(connection.phoneNumberId, connection.accessToken, conversation.contactPhone, {
            type: "text",
            text: noticeText,
          });
          metaMessageId = res.messageId;
        } catch {
          /* Non-fatal if out of session window */
        }
      }
      createdMessage = await WhatsAppMessageModel.create({
        ownerId,
        conversationId: conversation._id,
        direction: "outbound",
        senderPhone: "Support Desk",
        recipientPhone: conversation.contactPhone,
        type: "text",
        content: noticeText,
        status: metaMessageId ? "delivered" : "sent",
        metaMessageId,
      });
      conversation.lastMessageText = noticeText;
      conversation.lastMessageTimestamp = new Date();
      await conversation.save();
    }
  }

  response.status(200).json({ ok: true, supportCase, message: createdMessage });
}

// ----------------------------------------------------
// 6. Meta Forms (Lead Gen Forms & In-Chat Flows)
// ----------------------------------------------------
export async function listWhatsAppForms(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  let forms = await WhatsAppFormModel.find({ ownerId }).sort({ createdAt: -1 });

  if (false && forms.length === 0) {
    const initialForms = [
      {
        ownerId,
        title: "Patient Intake & Medical History",
        description: "Collect symptoms and preferred clinic doctor",
        triggerKeyword: "BOOK",
        submissionCount: 38,
        status: "active" as const,
        fields: [
          { id: "full_name", label: "Full Name", type: "text" as const, required: true },
          { id: "age", label: "Age", type: "number" as const, required: true },
          { id: "department", label: "Medical Department", type: "dropdown" as const, required: true, options: ["Cardiology", "Dentistry", "General Medicine", "Pediatrics"] },
          { id: "symptoms", label: "Brief Symptoms", type: "text" as const, required: false },
        ],
      },
      {
        ownerId,
        title: "Enterprise Voice AI Request",
        description: "Capture company size, contact, and call volume",
        triggerKeyword: "ENTERPRISE",
        submissionCount: 19,
        status: "active" as const,
        fields: [
          { id: "company_name", label: "Company Name", type: "text" as const, required: true },
          { id: "work_email", label: "Work Email", type: "email" as const, required: true },
          { id: "monthly_calls", label: "Monthly Inbound Calls", type: "dropdown" as const, required: true, options: ["< 5,000", "5,000 - 25,000", "25,000+"] },
        ],
      },
    ];
    await WhatsAppFormModel.insertMany(initialForms);
    forms = await WhatsAppFormModel.find({ ownerId }).sort({ createdAt: -1 });
  }

  response.status(200).json({ ok: true, forms });
}

export async function createWhatsAppForm(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { title, description, triggerKeyword, fields } = request.body;

  if (!title) throw new HttpError(400, "Form title is required.");

  const form = await WhatsAppFormModel.create({
    ownerId,
    title: title.trim(),
    description: description?.trim() || "",
    triggerKeyword: triggerKeyword?.trim().toUpperCase() || "",
    fields: Array.isArray(fields) ? fields : [],
  });

  response.status(201).json({ ok: true, form });
}

export async function getWhatsAppFormSubmissions(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { formId } = request.params;

  let submissions = await WhatsAppFormSubmissionModel.find({ ownerId, formId }).sort({ submittedAt: -1 });

  if (false && submissions.length === 0) {
    const defaultSubmissions = [
      {
        ownerId,
        formId: new Types.ObjectId(formId),
        contactPhone: "919876543210",
        contactName: "Rajesh Sharma",
        data: { full_name: "Rajesh Sharma", age: 42, department: "Cardiology", symptoms: "Mild chest discomfort on exertion" },
        submittedAt: new Date(Date.now() - 3600000),
      },
      {
        ownerId,
        formId: new Types.ObjectId(formId),
        contactPhone: "919876543211",
        contactName: "Pooja Patel",
        data: { full_name: "Pooja Patel", age: 29, department: "General Medicine", symptoms: "Fever and sore throat" },
        submittedAt: new Date(Date.now() - 7200000),
      },
    ];
    await WhatsAppFormSubmissionModel.insertMany(defaultSubmissions);
    submissions = await WhatsAppFormSubmissionModel.find({ ownerId, formId }).sort({ submittedAt: -1 });
  }

  response.status(200).json({ ok: true, submissions });
}

// ----------------------------------------------------
// 7. Flow Maker (Visual Automated Workflow Builder)
// ----------------------------------------------------
export async function listWhatsAppFlows(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  let flows = await WhatsAppFlowModel.find({ ownerId }).sort({ createdAt: -1 });

  if (flows.length === 0) {
    const initialFlows = [
      {
        ownerId,
        name: "Clinic Inbound Booking Flow",
        description: "Greets patient, shows medical departments, collects date, and triggers voice confirmation call.",
        triggerType: "keyword" as const,
        triggerKeyword: "HI",
        status: "active" as const,
        executionCount: 142,
        nodes: [
          { id: "1", type: "trigger", title: "Patient Sends Message", description: "Triggered on 'HI', 'HELLO', or 'BOOK'" },
          { id: "2", type: "message", title: "Greeting & Department Menu", description: "Send interactive button list of clinic doctors" },
          { id: "3", type: "form", title: "Collect Preferred Slot", description: "Prompt for time: Morning (10-1) or Evening (5-8)" },
          { id: "4", type: "action", title: "Book in EHR & Trigger Voice Bot", description: "Vozon AI voice agent calls patient to confirm" },
        ],
        edges: [
          { from: "1", to: "2" },
          { from: "2", to: "3" },
          { from: "3", to: "4" },
        ],
      },
      {
        ownerId,
        name: "Sales Qualification & Handover",
        description: "Qualifies enterprise leads and routes to executive live chat.",
        triggerType: "keyword" as const,
        triggerKeyword: "DEMO",
        status: "active" as const,
        executionCount: 68,
        nodes: [
          { id: "1", type: "trigger", title: "User Asks for Demo", description: "Inbound 'DEMO' or 'PRICING'" },
          { id: "2", type: "message", title: "AI Voicebot Capabilities Video", description: "Sends interactive video demo" },
          { id: "3", type: "condition", title: "Check Company Size", description: "If > 50 employees -> Handover to Human Sales" },
          { id: "4", type: "action", title: "Notify Slack & Live Chat", description: "Alert sales rep for instant human takeover" },
        ],
        edges: [
          { from: "1", to: "2" },
          { from: "2", to: "3" },
          { from: "3", to: "4" },
        ],
      },
    ];
    await WhatsAppFlowModel.insertMany(initialFlows);
    flows = await WhatsAppFlowModel.find({ ownerId }).sort({ createdAt: -1 });
  }

  response.status(200).json({ ok: true, flows });
}

export async function saveWhatsAppFlow(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { id, _id, name, description, triggerType, triggerKeyword, phoneNumberId, status, nodes, edges } = request.body;
  const flowId = id || _id;

  if (!name) throw new HttpError(400, "Flow name is required.");

  const assignedPhoneNumberId = typeof phoneNumberId === "string" ? phoneNumberId.trim() : "";
  if (assignedPhoneNumberId) {
    const linkedNumber = await ProviderIntegrationModel.exists({
      ownerId,
      provider: "whatsapp",
      status: "connected",
      $or: [{ accountId: assignedPhoneNumberId }, { "metadata.phoneNumberId": assignedPhoneNumberId }],
    });
    if (!linkedNumber) throw new HttpError(400, "Choose a WhatsApp number connected to this workspace.");
  }

  let flow;
  if (flowId) {
    flow = await WhatsAppFlowModel.findOneAndUpdate(
      { _id: flowId, ownerId },
      { $set: { name, description, triggerType, triggerKeyword, phoneNumberId: assignedPhoneNumberId, status, nodes, edges } },
      { new: true },
    );
  } else {
    flow = await WhatsAppFlowModel.create({
      ownerId,
      name,
      description: description || "",
      triggerType: triggerType || "keyword",
      triggerKeyword: triggerKeyword?.toUpperCase() || "",
      phoneNumberId: assignedPhoneNumberId,
      status: status || "active",
      nodes: Array.isArray(nodes) ? nodes : [],
      edges: Array.isArray(edges) ? edges : [],
    });
  }

  response.status(200).json({ ok: true, flow });
}

export async function deleteWhatsAppFlow(request: AuthenticatedRequest, response: Response) {
  const ownerId = orgId(request);
  const { id } = request.params;
  await WhatsAppFlowModel.findOneAndDelete({ _id: id, ownerId });
  response.status(200).json({ ok: true, message: "Flow deleted." });
}
