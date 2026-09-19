import { Schema, model, type InferSchemaType } from "mongoose";

const scheduledCallbackSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: "Campaign", required: true, index: true },
    campaignLeadId: { type: Schema.Types.ObjectId, ref: "CampaignLead", required: true, index: true },
    sourceCallId: { type: Schema.Types.ObjectId, ref: "CallDetailRecord", required: true, unique: true },
    callId: { type: Schema.Types.ObjectId, ref: "CallDetailRecord", default: null, index: true },
    agentId: { type: Schema.Types.ObjectId, ref: "VoiceAgent", required: true, index: true },
    phoneNumberId: { type: Schema.Types.ObjectId, ref: "PhoneNumber", required: true },
    destination: { type: String, required: true, trim: true },
    callerName: { type: String, trim: true, maxlength: 120, default: "" },
    reason: { type: String, trim: true, maxlength: 500, default: "" },
    requestedText: { type: String, trim: true, maxlength: 300, default: "" },
    timezone: { type: String, required: true, trim: true, maxlength: 100 },
    scheduledFor: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ["scheduled", "leased", "calling", "retry_wait", "completed", "needs_attention", "cancelled"],
      default: "scheduled",
      index: true,
    },
    attemptCount: { type: Number, min: 0, default: 0 },
    maxAttempts: { type: Number, min: 1, max: 10, default: 2 },
    retryGapSeconds: { type: Number, min: 60, max: 2592000, default: 3600 },
    lastAttemptAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastError: { type: String, trim: true, maxlength: 2000, default: "" },
    leaseToken: { type: String, trim: true, default: "", select: false },
    leasedUntil: { type: Date, default: null, index: true, select: false },
  },
  { timestamps: true },
);

scheduledCallbackSchema.index({ status: 1, scheduledFor: 1, leasedUntil: 1 });
scheduledCallbackSchema.index({ ownerId: 1, campaignId: 1, scheduledFor: 1 });
scheduledCallbackSchema.index({ campaignLeadId: 1, createdAt: -1 });

export type ScheduledCallback = InferSchemaType<typeof scheduledCallbackSchema>;
export const ScheduledCallbackModel = model<ScheduledCallback>(
  "ScheduledCallback",
  scheduledCallbackSchema,
);
