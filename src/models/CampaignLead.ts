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
    leaseToken: { type: String, trim: true, default: "", select: false },
    leasedUntil: { type: Date, default: null, index: true, select: false },
  },
  { timestamps: true },
);

campaignLeadSchema.index({ campaignId: 1, phone: 1 }, { unique: true });
campaignLeadSchema.index({ campaignId: 1, status: 1, nextAttemptAt: 1, leasedUntil: 1 });
campaignLeadSchema.index({ ownerId: 1, campaignId: 1, row: 1 });

export type CampaignLead = InferSchemaType<typeof campaignLeadSchema>;
export const CampaignLeadModel = model<CampaignLead>("CampaignLead", campaignLeadSchema);
