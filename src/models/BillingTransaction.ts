import { Schema, model, type InferSchemaType } from "mongoose";

const transactionBreakdownSchema = new Schema(
  {
    llm: { type: Number, min: 0, default: 0 },
    stt: { type: Number, min: 0, default: 0 },
    tts: { type: Number, min: 0, default: 0 },
    telephony: { type: Number, min: 0, default: 0 },
    providerCost: { type: Number, min: 0, default: 0 },
    markupMultiplier: { type: Number, min: 1, default: 1 },
    total: { type: Number, min: 0, default: 0 },
  },
  { _id: false },
);

const billingTransactionSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    type: {
      type: String,
      enum: ["topup", "deduction", "refund", "auto_reload"],
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: ["payment", "call", "adjustment", "auto_reload"],
      required: true,
      index: true,
    },
    amountCredits: { type: Number, required: true },
    currency: { type: String, trim: true, uppercase: true, default: "USD" },
    description: { type: String, trim: true, default: "" },
    callId: { type: String, trim: true, default: "", index: true },
    stripeSessionId: { type: String, trim: true, unique: true, sparse: true },
    stripePaymentIntentId: { type: String, trim: true, default: "" },
    balanceAfterCredits: { type: Number, min: 0, default: 0 },
    breakdown: { type: transactionBreakdownSchema, default: () => ({}) },
    metadata: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true },
);

billingTransactionSchema.index({ orgId: 1, createdAt: -1 });
billingTransactionSchema.index({ orgId: 1, type: 1, createdAt: -1 });
billingTransactionSchema.index({ orgId: 1, callId: 1, type: 1 });

export type BillingTransaction = InferSchemaType<typeof billingTransactionSchema>;
export const BillingTransactionModel = model<BillingTransaction>(
  "BillingTransaction",
  billingTransactionSchema,
);
