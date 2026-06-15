import { Schema, model, type InferSchemaType } from "mongoose";

export const apiKeyScopes = ["read", "agents:write", "calls:trigger", "full-access"] as const;
export type ApiKeyScope = (typeof apiKeyScopes)[number];

const apiKeySchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    prefix: { type: String, required: true, trim: true },
    keyHash: { type: String, required: true, unique: true, select: false },
    scopes: { type: [String], enum: apiKeyScopes, default: ["read"] },
    expiresAt: { type: Date },
    lastUsedAt: { type: Date },
    revokedAt: { type: Date },
  },
  { timestamps: true },
);

apiKeySchema.index({ orgId: 1, createdAt: -1 });

export type ApiKey = InferSchemaType<typeof apiKeySchema>;
export const ApiKeyModel = model<ApiKey>("ApiKey", apiKeySchema);
