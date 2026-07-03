import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

const campaignSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    createdBy: { type: String, required: true, index: true },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 160 },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    agentId: { type: Schema.Types.ObjectId, ref: "VoiceAgent", required: true, index: true },
    phoneNumberId: { type: Schema.Types.ObjectId, ref: "PhoneNumber", required: true },
    status: {
      type: String,
      enum: ["draft", "scheduled", "running", "paused", "completed", "cancelled", "failed"],
      default: "draft",
      index: true,
    },
    scheduledAt: { type: Date, default: null, index: true },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    timezone: { type: String, required: true, trim: true, default: "UTC" },
    windowStart: { type: String, required: true, default: "09:00" },
    windowEnd: { type: String, required: true, default: "18:00" },
    dailyLimit: { type: Number, required: true, min: 1, max: 100000, default: 250 },
    concurrency: { type: Number, required: true, min: 1, max: 100, default: 3 },
    maxAttempts: { type: Number, required: true, min: 1, max: 10, default: 1 },
    retryGapSeconds: { type: Number, required: true, min: 60, max: 2592000, default: 86400 },
    goal: { type: String, trim: true, maxlength: 2000, default: "" },
    successCriteria: { type: String, trim: true, maxlength: 2000, default: "" },
    respectDnc: { type: Boolean, required: true, default: true },
    requireConsentLine: { type: Boolean, required: true, default: true },
    detectVoicemail: { type: Boolean, required: true, default: true },
    totalLeads: { type: Number, min: 0, default: 0 },
    dailyAttemptDate: { type: String, trim: true, default: "" },
    dailyAttemptCount: { type: Number, min: 0, default: 0 },
    leaseToken: { type: String, trim: true, default: "", select: false },
    leasedUntil: { type: Date, default: null, index: true, select: false },
    lastWorkerError: { type: String, trim: true, maxlength: 2000, default: "" },
  },
  { timestamps: true },
);

campaignSchema.index({ ownerId: 1, idempotencyKey: 1 }, { unique: true });
campaignSchema.index({ status: 1, scheduledAt: 1, leasedUntil: 1 });
campaignSchema.index({ status: 1, updatedAt: 1 });
campaignSchema.index({ ownerId: 1, createdAt: -1 });

export type Campaign = InferSchemaType<typeof campaignSchema>;
export type CampaignDocument = HydratedDocument<Campaign>;
export const CampaignModel = model<Campaign>("Campaign", campaignSchema);
