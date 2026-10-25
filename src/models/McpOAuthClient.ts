import { Schema, model, type InferSchemaType } from "mongoose";

const mcpOAuthClientSchema = new Schema({
  clientId: { type: String, required: true, unique: true, index: true },
  clientName: { type: String, required: true, trim: true, maxlength: 120 },
  redirectUris: { type: [String], required: true },
}, { timestamps: true });

export type McpOAuthClient = InferSchemaType<typeof mcpOAuthClientSchema>;
export const McpOAuthClientModel = model<McpOAuthClient>("McpOAuthClient", mcpOAuthClientSchema);
