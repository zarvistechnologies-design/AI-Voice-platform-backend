import { Schema, model, type InferSchemaType } from "mongoose";

const schema = new Schema({
  accountId: { type: Schema.Types.ObjectId, ref: "WhiteLabelAccount", required: true, index: true },
  orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  packageId: { type: Schema.Types.ObjectId, required: true },
  packageName: { type: String, required: true },
  currency: { type: String, enum: ["INR", "USD"], required: true },
  amountMinor: { type: Number, required: true, min: 100 },
  credits: { type: Number, required: true, min: 0.01 },
  taxRateBps: { type: Number, min: 0, default: 0 },
  status: { type: String, enum: ["pending", "paid", "refunded", "disputed"], default: "pending", index: true },
  razorpayOrderId: { type: String, unique: true, sparse: true },
  razorpayPaymentId: { type: String, unique: true, sparse: true },
  paidAt: { type: Date },
  refundedMinor: { type: Number, min: 0, default: 0 },
  refundedCredits: { type: Number, min: 0, default: 0 },
  lastRefundId: { type: String, default: "" },
  refundedAt: { type: Date },
  disputeId: { type: String, default: "" },
  disputeStatus: {
    type: String,
    enum: ["none", "created", "under_review", "action_required", "won", "lost", "closed"],
    default: "none",
  },
}, { timestamps: true });

schema.index({ orgId: 1, createdAt: -1 });
export type WhiteLabelRechargeOrder = InferSchemaType<typeof schema>;
export const WhiteLabelRechargeOrderModel = model<WhiteLabelRechargeOrder>("WhiteLabelRechargeOrder", schema);
