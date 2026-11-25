import { Schema, model, type InferSchemaType } from "mongoose";

// --- 1. WhatsApp Contact Group ---
const whatsAppContactGroupSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    color: { type: String, default: "#118778" },
    contactCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export type WhatsAppContactGroup = InferSchemaType<typeof whatsAppContactGroupSchema>;
export const WhatsAppContactGroupModel = model<WhatsAppContactGroup>(
  "WhatsAppContactGroup",
  whatsAppContactGroupSchema,
);

// --- 2. WhatsApp Contact ---
const whatsAppContactSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    groupIds: [{ type: Schema.Types.ObjectId, ref: "WhatsAppContactGroup", index: true }],
    name: { type: String, required: true, trim: true },
    phoneNumber: { type: String, required: true, trim: true, index: true },
    email: { type: String, default: "", trim: true },
    tags: [{ type: String, trim: true }],
    status: { type: String, enum: ["subscribed", "opted_out", "pending_consent"], default: "pending_consent" },
    marketingOptInAt: { type: Date },
    marketingOptInSource: { type: String, default: "" },
    customAttributes: { type: Schema.Types.Mixed, default: {} },
    lastContactedAt: { type: Date },
  },
  { timestamps: true },
);

export type WhatsAppContact = InferSchemaType<typeof whatsAppContactSchema>;
export const WhatsAppContactModel = model<WhatsAppContact>(
  "WhatsAppContact",
  whatsAppContactSchema,
);

// --- 3. WhatsApp Message Template ---
const whatsAppTemplateSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ["MARKETING", "UTILITY", "AUTHENTICATION"],
      default: "MARKETING",
    },
    language: { type: String, default: "en" },
    status: {
      type: String,
      enum: ["APPROVED", "PENDING", "REJECTED"],
      default: "APPROVED",
    },
    headerType: {
      type: String,
      enum: ["NONE", "TEXT", "IMAGE", "VIDEO", "DOCUMENT"],
      default: "NONE",
    },
    headerText: { type: String, default: "" },
    headerMediaUrl: { type: String, default: "" },
    bodyText: { type: String, required: true },
    footerText: { type: String, default: "" },
    buttons: [
      {
        type: { type: String, enum: ["QUICK_REPLY", "URL", "PHONE_NUMBER"], default: "QUICK_REPLY" },
        text: { type: String, required: true },
        value: { type: String, default: "" },
      },
    ],
    metaTemplateId: { type: String, default: "" },
  },
  { timestamps: true },
);

export type WhatsAppTemplate = InferSchemaType<typeof whatsAppTemplateSchema>;
export const WhatsAppTemplateModel = model<WhatsAppTemplate>(
  "WhatsAppTemplate",
  whatsAppTemplateSchema,
);

// --- 4. WhatsApp Broadcast Campaign ---
const whatsAppCampaignSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    templateId: { type: Schema.Types.ObjectId, ref: "WhatsAppTemplate" },
    templateName: { type: String, default: "" },
    groupId: { type: Schema.Types.ObjectId, ref: "WhatsAppContactGroup" },
    groupName: { type: String, default: "" },
    senderPhoneNumberId: { type: String, default: "" },
    senderDisplayPhone: { type: String, default: "" },
    status: {
      type: String,
      enum: ["draft", "scheduled", "running", "completed", "failed"],
      default: "draft",
    },
    scheduledAt: { type: Date },
    sentAt: { type: Date },
    leaseId: { type: String, default: "", index: true },
    leaseExpiresAt: { type: Date, index: true },
    failureReason: { type: String, default: "" },
    variableMappings: { type: Schema.Types.Mixed, default: {} },
    stats: {
      recipients: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      read: { type: Number, default: 0 },
      replied: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

export type WhatsAppCampaign = InferSchemaType<typeof whatsAppCampaignSchema>;
export const WhatsAppCampaignModel = model<WhatsAppCampaign>(
  "WhatsAppCampaign",
  whatsAppCampaignSchema,
);

const whatsAppCampaignRecipientSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: "WhatsAppCampaign", required: true },
    contactId: { type: Schema.Types.ObjectId, ref: "WhatsAppContact", required: true },
    phoneNumber: { type: String, required: true },
    status: { type: String, enum: ["pending", "sending", "sent", "delivered", "read", "failed", "unknown"], default: "pending", index: true },
    attempts: { type: Number, default: 0 },
    metaMessageId: { type: String, default: "", index: true },
    lastError: { type: String, default: "" },
    attemptedAt: { type: Date },
  },
  { timestamps: true },
);
whatsAppCampaignRecipientSchema.index({ campaignId: 1, contactId: 1 }, { unique: true });
export type WhatsAppCampaignRecipient = InferSchemaType<typeof whatsAppCampaignRecipientSchema>;
export const WhatsAppCampaignRecipientModel = model<WhatsAppCampaignRecipient>("WhatsAppCampaignRecipient", whatsAppCampaignRecipientSchema);

// --- 5. WhatsApp Live Chat Conversation ---
const whatsAppConversationSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    contactPhone: { type: String, required: true, trim: true, index: true },
    contactName: { type: String, default: "Customer" },
    recipientPhoneNumberId: { type: String, default: "", index: true },
    recipientDisplayPhone: { type: String, default: "" },
    lastMessageText: { type: String, default: "" },
    lastMessageTimestamp: { type: Date, default: Date.now },
    unreadCount: { type: Number, default: 0 },
    status: { type: String, enum: ["open", "resolved"], default: "open" },
    mode: { type: String, enum: ["ai", "human"], default: "ai" },
    assignedAgentId: { type: String, default: "" },
    tags: [{ type: String }],
    activeFlowId: { type: String, default: "" },
    activeFlowNodeId: { type: String, default: "" },
    activeFlowContext: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

export type WhatsAppConversation = InferSchemaType<typeof whatsAppConversationSchema>;
export const WhatsAppConversationModel = model<WhatsAppConversation>(
  "WhatsAppConversation",
  whatsAppConversationSchema,
);

// --- 6. WhatsApp Message ---
const whatsAppMessageSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    conversationId: { type: Schema.Types.ObjectId, ref: "WhatsAppConversation", index: true },
    direction: { type: String, enum: ["inbound", "outbound"], required: true },
    senderPhone: { type: String, required: true },
    recipientPhone: { type: String, required: true },
    type: {
      type: String,
      enum: ["text", "template", "image", "document", "interactive"],
      default: "text",
    },
    content: { type: String, required: true },
    status: {
      type: String,
      enum: ["sent", "delivered", "read", "failed"],
      default: "sent",
    },
    campaignId: { type: Schema.Types.ObjectId, ref: "WhatsAppCampaign", index: true },
    metaMessageId: { type: String, default: "" },
  },
  { timestamps: true },
);

export type WhatsAppMessage = InferSchemaType<typeof whatsAppMessageSchema>;
export const WhatsAppMessageModel = model<WhatsAppMessage>(
  "WhatsAppMessage",
  whatsAppMessageSchema,
);

// --- 7. WhatsApp Meta Form ---
const whatsAppFormSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    triggerKeyword: { type: String, default: "" },
    // Empty means the flow is eligible on every connected WhatsApp number.
    phoneNumberId: { type: String, default: "", index: true },
    submissionCount: { type: Number, default: 0 },
    status: { type: String, enum: ["active", "draft", "paused"], default: "active" },
    fields: [
      {
        id: { type: String, required: true },
        label: { type: String, required: true },
        type: {
          type: String,
          enum: ["text", "number", "email", "phone", "dropdown", "date"],
          default: "text",
        },
        required: { type: Boolean, default: true },
        options: [{ type: String }],
      },
    ],
  },
  { timestamps: true },
);

export type WhatsAppForm = InferSchemaType<typeof whatsAppFormSchema>;
export const WhatsAppFormModel = model<WhatsAppForm>(
  "WhatsAppForm",
  whatsAppFormSchema,
);

// --- 8. WhatsApp Form Submission ---
const whatsAppFormSubmissionSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    formId: { type: Schema.Types.ObjectId, ref: "WhatsAppForm", index: true },
    contactPhone: { type: String, required: true },
    contactName: { type: String, default: "" },
    data: { type: Schema.Types.Mixed, default: {} },
    submittedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export type WhatsAppFormSubmission = InferSchemaType<typeof whatsAppFormSubmissionSchema>;
export const WhatsAppFormSubmissionModel = model<WhatsAppFormSubmission>(
  "WhatsAppFormSubmission",
  whatsAppFormSubmissionSchema,
);

// --- 9. WhatsApp Flow Maker ---
const whatsAppFlowSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    phoneNumberId: { type: String, default: "", index: true },
    triggerType: {
      type: String,
      enum: ["keyword", "new_contact", "campaign_response", "manual"],
      default: "keyword",
    },
    triggerKeyword: { type: String, default: "" },
    status: { type: String, enum: ["active", "draft", "paused"], default: "active" },
    nodes: [{ type: Schema.Types.Mixed }],
    edges: [{ type: Schema.Types.Mixed }],
    executionCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export type WhatsAppFlow = InferSchemaType<typeof whatsAppFlowSchema>;
export const WhatsAppFlowModel = model<WhatsAppFlow>(
  "WhatsAppFlow",
  whatsAppFlowSchema,
);

// --- 10. WhatsApp Agent Configuration ---
const whatsAppAgentConfigSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    voiceAgentId: { type: String, default: "" },
    enabled: { type: Boolean, default: true },
    autoReply: { type: Boolean, default: true },
    welcomeMessage: { type: String, default: "Hello! How can I assist you today?" },
    fallbackMessage: {
      type: String,
      default: "I'm connecting you with a human representative. Please wait a moment.",
    },
    transferKeywords: [{ type: String, default: ["agent", "human", "support", "help"] }],
    businessHoursOnly: { type: Boolean, default: false },
    officeHours: {
      start: { type: String, default: "09:00" },
      end: { type: String, default: "18:00" },
      timezone: { type: String, default: "Asia/Kolkata" },
    },
    adminDispatchPhones: [{ type: String }],
    adminDispatchAutomationId: { type: String, default: "" },
    adminDispatchMaxBatch: { type: Number, default: 200 },
  },
  { timestamps: true },
);

export type WhatsAppAgentConfig = InferSchemaType<typeof whatsAppAgentConfigSchema>;
export const WhatsAppAgentConfigModel = model<WhatsAppAgentConfig>(
  "WhatsAppAgentConfig",
  whatsAppAgentConfigSchema,
);

// --- 10a. Multi-Agent WhatsApp Custom AI Agents ---
const whatsAppCustomAgentSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, default: "Sales", trim: true },
    status: { type: String, enum: ["live", "draft", "paused"], default: "live", index: true },
    isDefault: { type: Boolean, default: false },
    phoneNumberId: { type: String, default: "", index: true },
    displayPhoneNumber: { type: String, default: "" },
    language: { type: String, default: "English + Hinglish" },
    tone: {
      type: String,
      enum: ["friendly", "professional", "concise", "consultative"],
      default: "friendly",
    },
    welcomeMessage: {
      type: String,
      default: "👋 Welcome! How can I help you today?",
    },
    systemPrompt: {
      type: String,
      default: "You are a helpful WhatsApp Business AI assistant. Answer clearly, politely, and concisely.",
    },
    knowledgeText: { type: String, default: "" },
    voiceAgentId: { type: String, default: "" },
    autoReply: { type: Boolean, default: true },
    allowCallback: { type: Boolean, default: true },
    triggerKeywords: [{ type: String, trim: true }],
    handoffRules: [
      {
        targetAgentId: { type: String, required: true, trim: true },
        targetAgentName: { type: String, default: "", trim: true },
        keywords: [{ type: String, trim: true }],
        condition: { type: String, default: "", trim: true },
        announceMessage: { type: String, default: "", trim: true },
      },
    ],
    transferKeywords: {
      type: [String],
      default: ["agent", "human", "representative", "help"],
    },
    fallbackMessage: {
      type: String,
      default: "I'm passing your conversation to a live specialist. They'll be with you shortly.",
    },
  },
  { timestamps: true },
);

export type WhatsAppCustomAgent = InferSchemaType<typeof whatsAppCustomAgentSchema>;
export const WhatsAppCustomAgentModel = model<WhatsAppCustomAgent>(
  "WhatsAppCustomAgent",
  whatsAppCustomAgentSchema,
);

// --- 10b. Admin-Only WhatsApp Bulk Dispatch Pending Batch ---
const whatsAppAdminDispatchBatchSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    adminPhone: { type: String, required: true, index: true },
    automationId: { type: String, required: true },
    automationName: { type: String, default: "" },
    code: { type: String, required: true },
    contacts: [{ name: { type: String, default: "" }, phone: { type: String, required: true } }],
    skippedDuplicates: { type: Number, default: 0 },
    skippedDnc: { type: Number, default: 0 },
    status: { type: String, enum: ["pending", "confirmed", "cancelled"], default: "pending", index: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
whatsAppAdminDispatchBatchSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 1800 });

export type WhatsAppAdminDispatchBatch = InferSchemaType<typeof whatsAppAdminDispatchBatchSchema>;
export const WhatsAppAdminDispatchBatchModel = model<WhatsAppAdminDispatchBatch>(
  "WhatsAppAdminDispatchBatch",
  whatsAppAdminDispatchBatchSchema,
);

// --- 11. WhatsApp Support Case / Ticket ---
const whatsAppSupportCaseSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    caseNumber: { type: String, required: true, trim: true, index: true },
    conversationId: { type: Schema.Types.ObjectId, ref: "WhatsAppConversation", index: true },
    contactPhone: { type: String, required: true, trim: true, index: true },
    contactName: { type: String, default: "Customer", trim: true },
    subject: { type: String, required: true, trim: true },
    category: { type: String, default: "General", trim: true },
    priority: { type: String, enum: ["low", "medium", "high", "urgent"], default: "medium" },
    status: { type: String, enum: ["open", "in_progress", "resolved"], default: "open" },
    slaDueAt: { type: Date, default: null, index: true },
    slaEscalatedAt: { type: Date, default: null },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

export type WhatsAppSupportCase = InferSchemaType<typeof whatsAppSupportCaseSchema>;
export const WhatsAppSupportCaseModel = model<WhatsAppSupportCase>(
  "WhatsAppSupportCase",
  whatsAppSupportCaseSchema,
);

