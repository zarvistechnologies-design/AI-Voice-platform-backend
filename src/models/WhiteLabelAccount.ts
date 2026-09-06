import { Schema, model, type InferSchemaType } from "mongoose";

const modelAccessSchema = new Schema(
  {
    stt: { type: [String], required: true },
    llm: { type: [String], required: true },
    tts: { type: [String], required: true },
  },
  { _id: false },
);

export const whiteLabelAccountStatuses = [
  "draft",
  "onboarding",
  "active",
  "suspended",
  "terminated",
] as const;

const whiteLabelAccountSchema = new Schema(
  {
    ownerOrgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      unique: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: 2,
      maxlength: 80,
    },
    status: {
      type: String,
      enum: whiteLabelAccountStatuses,
      default: "draft",
      index: true,
    },
    contract: {
      currency: { type: String, trim: true, uppercase: true, default: "USD", maxlength: 3 },
      billingInterval: { type: String, enum: ["month", "year"], default: "month" },
      platformFeeMinor: { type: Number, min: 0, default: 0 },
      minimumCommitmentMinor: { type: Number, min: 0, default: 0 },
      includedCredits: { type: Number, min: 0, default: 0 },
      wholesaleMarkupBps: { type: Number, min: 0, max: 100_000, default: 0 },
      platformFeePerMinuteCredits: { type: Number, min: 0, default: 0 },
      paymentTermsDays: { type: Number, min: 0, max: 180, default: 0 },
      creditLimitCredits: { type: Number, min: 0, default: 0 },
      autoSuspendOnPastDue: { type: Boolean, default: true },
      effectiveAt: { type: Date, default: Date.now },
    },
    limits: {
      brands: { type: Number, min: 1, max: 100, default: 1 },
      customerOrganizations: { type: Number, min: 1, max: 1_000_000, default: 25 },
      agentsPerCustomer: { type: Number, min: 1, max: 100_000, default: 10 },
      membersPerCustomer: { type: Number, min: 1, max: 100_000, default: 25 },
      phoneNumbersPerCustomer: { type: Number, min: 0, max: 100_000, default: 10 },
      concurrentCallsPerCustomer: { type: Number, min: 1, max: 100_000, default: 10 },
      monthlyMinutesPerCustomer: { type: Number, min: 0, max: 1_000_000_000, default: 10_000 },
    },
    entitlements: {
      customDomains: { type: Boolean, default: true },
      customApiDomains: { type: Boolean, default: false },
      customEmailBranding: { type: Boolean, default: true },
      removePoweredBy: { type: Boolean, default: false },
      customCustomerPricing: { type: Boolean, default: true },
      multipleBrands: { type: Boolean, default: false },
      bringYourOwnProviders: { type: Boolean, default: false },
      advancedAnalytics: { type: Boolean, default: true },
      developerApi: { type: Boolean, default: true },
    },
    // Missing on legacy accounts means unrestricted. Once a super admin saves
    // this field, its explicit arrays become the hard ceiling for new plans.
    modelAccess: { type: modelAccessSchema, default: undefined },
    usage: {
      brands: { type: Number, min: 0, default: 0 },
      customerOrganizations: { type: Number, min: 0, default: 0 },
    },
    customerOnboarding: {
      registrationMode: { type: String, enum: ["invite_only", "open"], default: "invite_only" },
      defaultPlanId: { type: Schema.Types.ObjectId, ref: "WhiteLabelPlan" },
      allowGoogleSignIn: { type: Boolean, default: false },
      requireEmailVerification: { type: Boolean, default: true },
    },
    retailBilling: {
      enabled: { type: Boolean, default: false },
      provider: { type: String, enum: ["razorpay", "internal"], default: "razorpay" },
      razorpayLinkedAccountId: { type: String, trim: true, default: "", maxlength: 120 },
      transferMode: { type: String, enum: ["disabled", "full_amount"], default: "disabled" },
      taxRateBps: { type: Number, min: 0, max: 100_000, default: 0 },
      taxLabel: { type: String, trim: true, default: "Tax", maxlength: 80 },
      taxRegistrationId: { type: String, trim: true, default: "", maxlength: 160 },
      gracePeriodDays: { type: Number, min: 0, max: 90, default: 3 },
    },
    billingStatus: {
      type: String,
      enum: ["not_configured", "trialing", "active", "past_due", "suspended", "cancelled"],
      default: "not_configured",
      index: true,
    },
    onboarding: {
      approvedAt: { type: Date },
      activatedAt: { type: Date },
      suspendedAt: { type: Date },
      terminatedAt: { type: Date },
      suspensionReason: { type: String, trim: true, default: "", maxlength: 1_000 },
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
    versionKey: "revision",
  },
);

whiteLabelAccountSchema.index({ status: 1, createdAt: -1 });
whiteLabelAccountSchema.index({ billingStatus: 1, status: 1 });

export type WhiteLabelAccount = InferSchemaType<typeof whiteLabelAccountSchema>;
export const WhiteLabelAccountModel = model<WhiteLabelAccount>(
  "WhiteLabelAccount",
  whiteLabelAccountSchema,
);
