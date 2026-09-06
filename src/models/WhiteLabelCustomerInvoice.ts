import { Schema, model, type InferSchemaType } from "mongoose";

const whiteLabelCustomerInvoiceSchema = new Schema(
  {
    accountId: { type: Schema.Types.ObjectId, ref: "WhiteLabelAccount", required: true, index: true },
    brandId: { type: Schema.Types.ObjectId, ref: "WhiteLabelBrand", required: true, index: true },
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: "WhiteLabelSubscription", required: true, index: true },
    invoiceNumber: { type: String, required: true, trim: true, unique: true },
    kind: { type: String, enum: ["initial", "renewal", "replacement"], required: true },
    sequence: { type: Number, min: 0, default: 0 },
    replacementOfInvoiceId: {
      type: Schema.Types.ObjectId,
      ref: "WhiteLabelCustomerInvoice",
      unique: true,
      sparse: true,
    },
    grantsAllowance: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["open", "paid", "past_due", "disputed", "void", "refunded"],
      default: "open",
      index: true,
    },
    provider: { type: String, enum: ["razorpay", "internal"], default: "razorpay" },
    currency: { type: String, enum: ["USD", "INR"], required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    dueAt: { type: Date, required: true, index: true },
    recurringAmountMinor: { type: Number, min: 0, required: true },
    setupFeeMinor: { type: Number, min: 0, required: true },
    subtotalMinor: { type: Number, min: 0, required: true },
    taxBehavior: { type: String, enum: ["exclusive", "inclusive", "unspecified"], required: true },
    taxRateBps: { type: Number, min: 0, max: 100_000, default: 0 },
    taxLabel: { type: String, trim: true, default: "Tax", maxlength: 80 },
    taxRegistrationId: { type: String, trim: true, default: "", maxlength: 160 },
    taxMinor: { type: Number, min: 0, required: true },
    totalMinor: { type: Number, min: 0, required: true },
    razorpayOrderId: { type: String, trim: true, unique: true, sparse: true },
    razorpayPaymentId: { type: String, trim: true, unique: true, sparse: true },
    paymentMethod: { type: String, trim: true, default: "", maxlength: 80 },
    transferMode: { type: String, enum: ["disabled", "full_amount"], default: "disabled" },
    razorpayLinkedAccountId: { type: String, trim: true, default: "", maxlength: 120 },
    razorpayTransferId: { type: String, trim: true, unique: true, sparse: true },
    transferStatus: {
      type: String,
      enum: ["not_applicable", "pending", "processed", "failed", "reversed"],
      default: "not_applicable",
      index: true,
    },
    refundedMinor: { type: Number, min: 0, default: 0 },
    refundStatus: { type: String, enum: ["none", "partial", "full"], default: "none" },
    lastRefundId: { type: String, trim: true, default: "", maxlength: 120 },
    disputeId: { type: String, trim: true, default: "", maxlength: 120, index: true },
    disputeStatus: {
      type: String,
      enum: ["none", "created", "under_review", "action_required", "won", "lost", "closed"],
      default: "none",
    },
    disputeReason: { type: String, trim: true, default: "", maxlength: 1_000 },
    disputedAt: { type: Date },
    paidAt: { type: Date },
    dueNoticeSentAt: { type: Date },
    pastDueNoticeSentAt: { type: Date },
    pausedNoticeSentAt: { type: Date },
    failureMessage: { type: String, trim: true, default: "", maxlength: 1_000 },
  },
  { timestamps: true, optimisticConcurrency: true, versionKey: "revision" },
);

whiteLabelCustomerInvoiceSchema.index(
  { subscriptionId: 1, periodStart: 1, kind: 1, sequence: 1 },
  { unique: true },
);
whiteLabelCustomerInvoiceSchema.index({ accountId: 1, status: 1, dueAt: 1 });
whiteLabelCustomerInvoiceSchema.index({ orgId: 1, createdAt: -1 });

export type WhiteLabelCustomerInvoice = InferSchemaType<typeof whiteLabelCustomerInvoiceSchema>;
export const WhiteLabelCustomerInvoiceModel = model<WhiteLabelCustomerInvoice>(
  "WhiteLabelCustomerInvoice",
  whiteLabelCustomerInvoiceSchema,
);
