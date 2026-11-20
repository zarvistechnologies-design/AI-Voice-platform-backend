import { randomBytes } from "node:crypto";
import { Schema, model } from "mongoose";

const automationSchema = new Schema({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 500, default: "" },
  status: { type: String, enum: ["draft", "live", "paused"], default: "draft", index: true },
  revision: { type: Number, default: 1 },
  publishedVersion: { type: Number, default: 0 },
  draft: { type: Schema.Types.Mixed, required: true },
  published: { type: Schema.Types.Mixed, default: null },
  createdBy: { type: String, required: true },
  publishedBy: { type: String, default: "" },
  publishedAt: { type: Date, default: null },
  triggerCursor: { type: String, default: "" },
  webhookSecret: { type: String, default: () => randomBytes(24).toString("hex") },
}, { timestamps: true, minimize: false });
automationSchema.index({ ownerId: 1, updatedAt: -1 });

export const AutomationModel = model("Automation", automationSchema);

const automationVersionSchema = new Schema({
  ownerId: { type: String, required: true, index: true },
  automationId: { type: Schema.Types.ObjectId, ref: "Automation", required: true, index: true },
  version: { type: Number, required: true },
  graph: { type: Schema.Types.Mixed, required: true },
  name: { type: String, required: true },
  publishedBy: { type: String, required: true },
}, { timestamps: true, minimize: false });
automationVersionSchema.index({ automationId: 1, version: 1 }, { unique: true });
export const AutomationVersionModel = model("AutomationVersion", automationVersionSchema);

const automationRunSchema = new Schema({
  ownerId: { type: String, required: true, index: true },
  automationId: { type: Schema.Types.ObjectId, ref: "Automation", required: true, index: true },
  version: { type: Number, required: true },
  graph: { type: Schema.Types.Mixed, required: true },
  eventId: { type: String, required: true, maxlength: 160 },
  contactName: { type: String, trim: true, maxlength: 120, default: "" },
  contactPhone: { type: String, trim: true, maxlength: 40, default: "" },
  status: { type: String, enum: ["queued", "running", "waiting", "completed", "failed", "cancelled"], default: "queued", index: true },
  currentNodeId: { type: String, default: "" },
  waitKind: {
    type: String,
    enum: ["", "delay", "call", "call_retry", "window", "whatsapp_delivery", "whatsapp_reply", "payment_paid", "case_resolved"],
    default: "",
  },
  actionType: { type: String, enum: ["", "call", "whatsapp", "payment", "calendar", "crm", "case", "notification"], default: "" },
  actionNodeId: { type: String, default: "" },
  dueAt: { type: Date, default: null, index: true },
  callId: { type: String, default: "" },
  whatsappMessageId: { type: String, default: "" },
  whatsappSentAt: { type: Date, default: null },
  context: { type: Schema.Types.Mixed, default: {} },
  steps: { type: [Schema.Types.Mixed], default: [] },
  error: { type: String, default: "" },
  leaseUntil: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
}, { timestamps: true, minimize: false, optimisticConcurrency: true });
automationRunSchema.index({ automationId: 1, eventId: 1 }, { unique: true });
automationRunSchema.index({ status: 1, dueAt: 1, leaseUntil: 1 });
automationRunSchema.index({ ownerId: 1, automationId: 1, createdAt: -1 });
automationRunSchema.index({ ownerId: 1, automationId: 1, contactPhone: 1, status: 1 });

export const AutomationRunModel = model("AutomationRun", automationRunSchema);

const automationWhatsAppStatusSchema = new Schema({
  messageId: { type: String, required: true, unique: true, maxlength: 200 },
  status: { type: String, enum: ["sent", "delivered", "read", "failed"], required: true },
  error: { type: String, default: "", maxlength: 500 },
  providerTimestamp: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
automationWhatsAppStatusSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AutomationWhatsAppStatusModel = model("AutomationWhatsAppStatus", automationWhatsAppStatusSchema);
