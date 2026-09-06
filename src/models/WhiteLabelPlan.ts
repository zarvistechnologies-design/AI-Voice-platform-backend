import { Schema, model, type InferSchemaType } from "mongoose";

const modelAccessSchema = new Schema(
  {
    stt: { type: [String], required: true },
    llm: { type: [String], required: true },
    tts: { type: [String], required: true },
  },
  { _id: false },
);

const whiteLabelPlanSchema = new Schema(
  {
    accountId: {
      type: Schema.Types.ObjectId,
      ref: "WhiteLabelAccount",
      required: true,
      index: true,
    },
    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      minlength: 2,
      maxlength: 80,
    },
    version: { type: Number, min: 1, default: 1 },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    description: { type: String, trim: true, default: "", maxlength: 1_000 },
    status: { type: String, enum: ["draft", "published", "archived"], default: "draft", index: true },
    isPublic: { type: Boolean, default: true },
    price: {
      currency: { type: String, trim: true, uppercase: true, required: true, maxlength: 3 },
      recurringAmountMinor: { type: Number, min: 0, required: true },
      interval: { type: String, enum: ["month", "year"], default: "month" },
      setupFeeMinor: { type: Number, min: 0, default: 0 },
      trialDays: { type: Number, min: 0, max: 365, default: 0 },
      taxBehavior: { type: String, enum: ["exclusive", "inclusive", "unspecified"], default: "unspecified" },
    },
    usagePricing: {
      mode: {
        type: String,
        enum: ["cost_markup", "fixed_per_minute", "included_only"],
        default: "cost_markup",
      },
      markupBps: { type: Number, min: 0, max: 100_000, default: 0 },
      perMinuteAmountMinor: { type: Number, min: 0, default: 0 },
      minimumCallAmountMinor: { type: Number, min: 0, default: 0 },
      overageEnabled: { type: Boolean, default: true },
    },
    allowances: {
      includedCredits: { type: Number, min: 0, default: 0 },
      includedMinutes: { type: Number, min: 0, default: 0 },
    },
    limits: {
      agents: { type: Number, min: 0, max: 100_000, default: 1 },
      members: { type: Number, min: 1, max: 100_000, default: 5 },
      phoneNumbers: { type: Number, min: 0, max: 100_000, default: 1 },
      concurrentCalls: { type: Number, min: 0, max: 100_000, default: 1 },
      monthlyMinutes: { type: Number, min: 0, max: 1_000_000_000, default: 100 },
      knowledgeSources: { type: Number, min: 0, max: 1_000_000, default: 10 },
      apiKeys: { type: Number, min: 0, max: 100_000, default: 1 },
    },
    features: {
      campaigns: { type: Boolean, default: true },
      inboundCalling: { type: Boolean, default: true },
      outboundCalling: { type: Boolean, default: true },
      callRecording: { type: Boolean, default: false },
      knowledgeBase: { type: Boolean, default: true },
      integrations: { type: Boolean, default: true },
      developerApi: { type: Boolean, default: false },
      advancedAnalytics: { type: Boolean, default: false },
      teamAccess: { type: Boolean, default: true },
    },
    // Missing on legacy plans means inherit the account ceiling.
    modelAccess: { type: modelAccessSchema, default: undefined },
    publishedAt: { type: Date },
    archivedAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

whiteLabelPlanSchema.index({ accountId: 1, key: 1, version: 1 }, { unique: true });
whiteLabelPlanSchema.index({ accountId: 1, status: 1, isPublic: 1, createdAt: -1 });

export type WhiteLabelPlan = InferSchemaType<typeof whiteLabelPlanSchema>;
export const WhiteLabelPlanModel = model<WhiteLabelPlan>("WhiteLabelPlan", whiteLabelPlanSchema);
