import { Schema, model, type InferSchemaType } from "mongoose";

const mcpOAuthAuthorizationRequestSchema = new Schema({
  clientId: { type: String, required: true, index: true },
  redirectUri: { type: String, required: true },
  codeChallenge: { type: String, required: true },
  state: { type: String, required: true },
  scopes: { type: [String], default: ["vozon:read"] },
  resource: { type: String, required: true },
  status: { type: String, enum: ["pending", "approved", "denied", "exchanged"], default: "pending", index: true },
  userId: { type: String, default: "" },
  organizationId: { type: String, default: "" },
  codeHash: { type: String, default: "", select: false, index: true },
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });

export type McpOAuthAuthorizationRequest = InferSchemaType<typeof mcpOAuthAuthorizationRequestSchema>;
export const McpOAuthAuthorizationRequestModel = model<McpOAuthAuthorizationRequest>(
  "McpOAuthAuthorizationRequest",
  mcpOAuthAuthorizationRequestSchema,
);
