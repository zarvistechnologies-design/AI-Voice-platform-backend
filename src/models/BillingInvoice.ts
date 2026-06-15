import { Schema, model, type InferSchemaType } from "mongoose";

const billingInvoiceSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    stripeInvoiceId: { type: String, required: true, unique: true },
    status: { type: String, trim: true, default: "" },
    amountDue: { type: Number, min: 0, default: 0 },
    amountPaid: { type: Number, min: 0, default: 0 },
    currency: { type: String, trim: true, default: "usd" },
    hostedInvoiceUrl: { type: String, trim: true, default: "" },
    invoicePdf: { type: String, trim: true, default: "" },
    periodStart: { type: Date },
    periodEnd: { type: Date },
  },
  { timestamps: true },
);

billingInvoiceSchema.index({ orgId: 1, createdAt: -1 });

export type BillingInvoice = InferSchemaType<typeof billingInvoiceSchema>;
export const BillingInvoiceModel = model<BillingInvoice>("BillingInvoice", billingInvoiceSchema);
