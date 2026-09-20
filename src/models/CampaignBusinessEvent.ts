import { Schema, model, type InferSchemaType } from "mongoose";

const campaignBusinessEventSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: "Campaign", required: true, index: true },
    campaignLeadId: { type: Schema.Types.ObjectId, ref: "CampaignLead", required: true, index: true },
    callId: { type: Schema.Types.ObjectId, ref: "CallDetailRecord", default: null, index: true },
    type: {
      type: String,
      enum: ["appointment", "booking", "payment", "revenue", "lead", "other"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "verified", "rejected", "refunded"],
      required: true,
      default: "verified",
      index: true,
    },
    source: {
      type: String,
      enum: ["tool", "crm", "webhook", "human", "analysis"],
      required: true,
      index: true,
    },
    label: { type: String, trim: true, maxlength: 300, default: "" },
    amount: { type: Number, min: 0, default: 0 },
    currency: { type: String, trim: true, maxlength: 10, default: "INR" },
    externalId: { type: String, trim: true, maxlength: 300, default: "" },
    dedupeKey: { type: String, required: true, trim: true, maxlength: 500 },
    evidence: { type: Schema.Types.Mixed, default: {} },
    occurredAt: { type: Date, required: true, default: Date.now },
    createdBy: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

campaignBusinessEventSchema.index({ ownerId: 1, dedupeKey: 1 }, { unique: true });
campaignBusinessEventSchema.index({ campaignId: 1, status: 1, occurredAt: -1 });
campaignBusinessEventSchema.index({ campaignLeadId: 1, occurredAt: -1 });

export type CampaignBusinessEvent = InferSchemaType<typeof campaignBusinessEventSchema>;
export const CampaignBusinessEventModel = model<CampaignBusinessEvent>(
  "CampaignBusinessEvent",
  campaignBusinessEventSchema,
);
