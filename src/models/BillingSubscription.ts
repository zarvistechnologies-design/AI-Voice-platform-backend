import { Schema, model, type InferSchemaType } from "mongoose";

const billingSubscriptionSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, unique: true },
    provider: { type: String, enum: ["internal", "razorpay"], default: "internal" },
    plan: {
      type: String,
      enum: ["free", "starter", "growth", "enterprise"],
      default: "free",
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "trialing", "past_due", "cancelled", "incomplete"],
      default: "active",
      index: true,
    },
    razorpayCustomerId: { type: String, trim: true, default: "", index: true },
    razorpayPlanId: { type: String, trim: true, default: "", index: true },
    razorpaySubscriptionId: { type: String, trim: true, default: "", index: true },
    currentPeriodStart: { type: Date },
    currentPeriodEnd: { type: Date },
    cancelAtPeriodEnd: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export type BillingSubscription = InferSchemaType<typeof billingSubscriptionSchema>;
export const BillingSubscriptionModel = model<BillingSubscription>(
  "BillingSubscription",
  billingSubscriptionSchema,
);

