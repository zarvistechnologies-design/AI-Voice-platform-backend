import { Schema, model, type InferSchemaType } from "mongoose";

const campaignLeadSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: "Campaign", required: true, index: true },
    row: { type: Number, required: true, min: 1 },
    phone: { type: String, required: true, trim: true },
    name: { type: String, trim: true, maxlength: 300, default: "" },
    email: { type: String, trim: true, maxlength: 320, default: "" },
    company: { type: String, trim: true, maxlength: 300, default: "" },
    customFields: { type: Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ["queued", "leased", "active", "completed", "retry_wait", "failed", "suppressed", "cancelled"],
      default: "queued",
      index: true,
    },
    attemptCount: { type: Number, min: 0, default: 0 },
    nextAttemptAt: { type: Date, default: null, index: true },
    lastAttemptAt: { type: Date, default: null },
    callId: { type: Schema.Types.ObjectId, ref: "CallDetailRecord", default: null, index: true },
    lastError: { type: String, trim: true, maxlength: 2000, default: "" },
    suppressionReason: { type: String, trim: true, maxlength: 500, default: "" },
    outcome: {
      type: String,
      enum: ["unknown", "qualified", "follow_up", "resolved", "missed", "not_interested"],
      default: "unknown",
      index: true,
    },
    outcomeEvidence: {
      type: String,
      enum: ["unknown", "inferred", "system_confirmed", "human_reviewed"],
      default: "unknown",
    },
    outcomeCallId: { type: Schema.Types.ObjectId, ref: "CallDetailRecord", default: null },
    outcomeUpdatedAt: { type: Date, default: null },
    outcomeReviewNote: { type: String, trim: true, maxlength: 500, default: "" },
    outcomeReviewedBy: { type: String, trim: true, default: "" },
    outcomeEvidenceQuote: { type: String, trim: true, maxlength: 1000, default: "" },
    outcomeEvidenceItemId: { type: String, trim: true, maxlength: 200, default: "" },
    qaScore: { type: Number, min: 0, max: 100, default: 0 },
    qaGrade: { type: String, enum: ["", "A", "B", "C", "D", "F"], default: "" },
    qaChecks: { type: Schema.Types.Mixed, default: {} },
    qaUpdatedAt: { type: Date, default: null },
    conversionType: {
      type: String,
      enum: ["", "appointment", "booking", "payment", "revenue", "lead", "other"],
      default: "",
      index: true,
    },
    conversionStatus: {
      type: String,
      enum: ["", "pending", "verified", "rejected", "refunded"],
      default: "",
      index: true,
    },
    attributedRevenue: { type: Number, min: 0, default: 0 },
    revenueCurrency: { type: String, trim: true, maxlength: 10, default: "INR" },
    conversionExternalId: { type: String, trim: true, maxlength: 300, default: "" },
    conversionVerifiedAt: { type: Date, default: null },
    crmSyncStatus: {
      type: String,
      enum: ["", "not_configured", "pending", "synced", "failed"],
      default: "",
      index: true,
    },
    crmSyncedAt: { type: Date, default: null },
    crmSyncError: { type: String, trim: true, maxlength: 1000, default: "" },
    callbackStatus: {
      type: String,
      enum: ["", "scheduled", "calling", "completed", "retry_wait", "needs_attention", "cancelled"],
      default: "",
      index: true,
    },
    callbackScheduledFor: { type: Date, default: null, index: true },
    leaseToken: { type: String, trim: true, default: "", select: false },
    leasedUntil: { type: Date, default: null, index: true, select: false },
  },
  { timestamps: true },
);

campaignLeadSchema.index({ campaignId: 1, phone: 1 }, { unique: true });
campaignLeadSchema.index({ campaignId: 1, status: 1, nextAttemptAt: 1, leasedUntil: 1 });
campaignLeadSchema.index({ campaignId: 1, row: 1 });
campaignLeadSchema.index({ ownerId: 1, campaignId: 1, row: 1 });
campaignLeadSchema.index({ campaignId: 1, outcome: 1, callbackStatus: 1, row: 1 });

export type CampaignLead = InferSchemaType<typeof campaignLeadSchema>;
export const CampaignLeadModel = model<CampaignLead>("CampaignLead", campaignLeadSchema);
