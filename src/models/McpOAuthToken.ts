import { Schema, model, type InferSchemaType } from "mongoose";

const mcpOAuthTokenSchema = new Schema({
  clientId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  organizationId: { type: String, required: true, index: true },
  scopes: { type: [String], default: ["vozon:read"] },
  accessTokenHash: { type: String, required: true, unique: true, select: false },
  accessExpiresAt: { type: Date, required: true },
  refreshTokenHash: { type: String, required: true, unique: true, select: false },
  refreshExpiresAt: { type: Date, required: true, expires: 0 },
  revokedAt: { type: Date },
}, { timestamps: true });

export type McpOAuthToken = InferSchemaType<typeof mcpOAuthTokenSchema>;
export const McpOAuthTokenModel = model<McpOAuthToken>("McpOAuthToken", mcpOAuthTokenSchema);
