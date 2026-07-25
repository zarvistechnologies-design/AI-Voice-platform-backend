import { Schema, model, type InferSchemaType } from "mongoose";

const billingProviderConfigSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    value: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

export type BillingProviderConfig = InferSchemaType<typeof billingProviderConfigSchema>;
export const BillingProviderConfigModel = model<BillingProviderConfig>(
  "BillingProviderConfig",
  billingProviderConfigSchema,
);
