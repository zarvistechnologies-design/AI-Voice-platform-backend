import { Schema, model, type InferSchemaType } from "mongoose";

const providerIntegrationSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    provider: { type: String, required: true, enum: ["vobiz"] },
    accountId: { type: String, required: true, trim: true },
    secretEncrypted: { type: String, required: true, select: false },
    status: { type: String, enum: ["connected", "error"], default: "connected" },
    lastVerifiedAt: { type: Date, required: true },
    metadata: {
      ownedNumberCount: { type: Number, min: 0, default: 0 },
    },
  },
  { timestamps: true },
);

providerIntegrationSchema.index({ ownerId: 1, provider: 1 }, { unique: true });

export type ProviderIntegration = InferSchemaType<typeof providerIntegrationSchema>;
export const ProviderIntegrationModel = model<ProviderIntegration>(
  "ProviderIntegration",
  providerIntegrationSchema,
);
