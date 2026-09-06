import { Schema, model, type InferSchemaType } from "mongoose";

const whiteLabelSubscriptionSchema = new Schema(
  {
    accountId: {
      type: Schema.Types.ObjectId,
      ref: "WhiteLabelAccount",
      required: true,
      index: true,
    },
    brandId: {
      type: Schema.Types.ObjectId,
      ref: "WhiteLabelBrand",
      required: true,
      index: true,
    },
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      unique: true,
      index: true,
    },
    planId: { type: Schema.Types.ObjectId, ref: "WhiteLabelPlan", required: true, index: true },
    planKey: { type: String, required: true, trim: true, lowercase: true },
    planVersion: { type: Number, min: 1, required: true },
    status: {
      type: String,
      enum: ["incomplete", "trialing", "active", "past_due", "paused", "cancelled", "expired"],
      default: "active",
      index: true,
    },
    priceSnapshot: { type: Schema.Types.Mixed, required: true },
    usagePricingSnapshot: { type: Schema.Types.Mixed, required: true },
    allowancesSnapshot: { type: Schema.Types.Mixed, required: true },
    limitsSnapshot: { type: Schema.Types.Mixed, required: true },
    featuresSnapshot: { type: Schema.Types.Mixed, required: true },
    modelAccessSnapshot: { type: Schema.Types.Mixed },
    provider: { type: String, enum: ["internal", "razorpay", "stripe"], default: "internal" },
    providerCustomerId: { type: String, trim: true, default: "", index: true },
    providerSubscriptionId: { type: String, trim: true, default: "", unique: true, sparse: true },
    currentPeriodStart: { type: Date },
    currentPeriodEnd: { type: Date },
    trialEndsAt: { type: Date },
    pastDueAt: { type: Date },
    graceEndsAt: { type: Date },
    billingSuspendedAt: { type: Date },
    lastPaymentAt: { type: Date },
    lastPaymentInvoiceId: { type: Schema.Types.ObjectId, ref: "WhiteLabelCustomerInvoice" },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    cancelledAt: { type: Date },
    cancellationReason: { type: String, trim: true, default: "", maxlength: 1_000 },
    activeCallSlots: { type: Number, min: 0, default: 0, select: false },
    capacityRevision: { type: Number, min: 0, default: 0, select: false },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
    versionKey: "revision",
  },
);

whiteLabelSubscriptionSchema.index({ accountId: 1, status: 1, createdAt: -1 });
whiteLabelSubscriptionSchema.index({ accountId: 1, planId: 1, status: 1 });

export type WhiteLabelSubscription = InferSchemaType<typeof whiteLabelSubscriptionSchema>;
export const WhiteLabelSubscriptionModel = model<WhiteLabelSubscription>(
  "WhiteLabelSubscription",
  whiteLabelSubscriptionSchema,
);
