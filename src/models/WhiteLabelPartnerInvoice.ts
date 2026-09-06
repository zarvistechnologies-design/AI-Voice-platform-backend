import { Schema, model, type InferSchemaType } from "mongoose";

const whiteLabelPartnerInvoiceSchema = new Schema(
  {
    accountId: {
      type: Schema.Types.ObjectId,
      ref: "WhiteLabelAccount",
      required: true,
      index: true,
    },
    ownerOrgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    invoiceNumber: { type: String, required: true, trim: true, unique: true },
    status: {
      type: String,
      enum: ["open", "paid", "past_due", "void"],
      default: "open",
      index: true,
    },
    provider: {
      type: String,
      enum: ["razorpay", "internal"],
      default: "razorpay",
    },
    currency: {
      type: String,
      enum: ["USD", "INR"],
      required: true,
    },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    usageStart: { type: Date, required: true },
    usageEnd: { type: Date, required: true },
    dueAt: { type: Date, required: true, index: true },
    platformFeeMinor: { type: Number, min: 0, required: true },
    minimumCommitmentMinor: { type: Number, min: 0, required: true },
    usageWholesaleMinor: { type: Number, min: 0, required: true },
    includedCreditDiscountMinor: { type: Number, min: 0, required: true },
    usageMarkupMinor: { type: Number, min: 0, required: true },
    committedUsageMinor: { type: Number, min: 0, required: true },
    totalMinor: { type: Number, min: 0, required: true },
    razorpayOrderId: { type: String, trim: true, unique: true, sparse: true },
    razorpayPaymentId: { type: String, trim: true, unique: true, sparse: true },
    paymentMethod: { type: String, trim: true, default: "" },
    paidAt: { type: Date },
    failureMessage: { type: String, trim: true, default: "", maxlength: 1_000 },
  },
  { timestamps: true, optimisticConcurrency: true, versionKey: "revision" },
);

whiteLabelPartnerInvoiceSchema.index({ accountId: 1, periodStart: 1 }, { unique: true });
whiteLabelPartnerInvoiceSchema.index({ accountId: 1, createdAt: -1 });

export type WhiteLabelPartnerInvoice = InferSchemaType<typeof whiteLabelPartnerInvoiceSchema>;
export const WhiteLabelPartnerInvoiceModel = model<WhiteLabelPartnerInvoice>(
  "WhiteLabelPartnerInvoice",
  whiteLabelPartnerInvoiceSchema,
);
