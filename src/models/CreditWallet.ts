import { Schema, model, type InferSchemaType } from "mongoose";

const creditWalletSchema = new Schema(
  {
    orgId: { type: String, required: true, unique: true, index: true },
    // A negative balance is durable call debt. It prevents new admissions but
    // still records the full cost of already-admitted concurrent calls.
    balanceCredits: { type: Number, default: 0 },
    lifetimePurchasedCredits: { type: Number, min: 0, default: 0 },
    currency: { type: String, trim: true, uppercase: true, default: "USD" },
    autoReloadEnabled: { type: Boolean, default: false },
    reloadThresholdCredits: { type: Number, min: 0, default: 5 },
    reloadAmountCredits: { type: Number, min: 1, default: 10 },
    paymentProvider: {
      type: String,
      enum: ["", "internal", "stripe", "razorpay"],
      default: "",
    },
    stripeCustomerId: { type: String, trim: true, default: "", index: true },
    stripePaymentMethodId: { type: String, trim: true, default: "" },
    lastPaymentStatus: {
      type: String,
      enum: ["none", "pending", "success", "failed"],
      default: "none",
    },
    lastPaymentAmountCredits: { type: Number, min: 0, default: 0 },
    lastPaymentAt: { type: Date },
    lastCheckedAt: { type: Date },
    autoReloadLockUntil: { type: Date },
    autoReloadIdempotencyKey: { type: String, trim: true, default: "", select: false },
  },
  { timestamps: true },
);

export type CreditWallet = InferSchemaType<typeof creditWalletSchema>;
export const CreditWalletModel = model<CreditWallet>("CreditWallet", creditWalletSchema);
