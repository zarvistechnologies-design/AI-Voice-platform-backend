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
    status: { type: String, enum: ["subscribed", "opted_out"], default: "subscribed" },
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
  },
  { timestamps: true },
);

export type WhatsAppAgentConfig = InferSchemaType<typeof whatsAppAgentConfigSchema>;
export const WhatsAppAgentConfigModel = model<WhatsAppAgentConfig>(
  "WhatsAppAgentConfig",
  whatsAppAgentConfigSchema,
);

