import { Schema, model, type InferSchemaType } from "mongoose";

const remoteMcpConnectionSchema = new Schema({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  provider: { type: String, required: true, trim: true, maxlength: 80 },
  urlOrigin: { type: String, required: true, trim: true, maxlength: 500 },
  urlEncrypted: { type: String, required: true, select: false },
  secretEncrypted: { type: String, default: "", select: false },
  status: { type: String, enum: ["connected", "error"], default: "connected" },
  lastVerifiedAt: { type: Date, default: null },
  lastError: { type: String, default: "" },
  tools: { type: [Schema.Types.Mixed], default: [] },
}, { timestamps: true });

remoteMcpConnectionSchema.index({ ownerId: 1, provider: 1 });

export type RemoteMcpConnection = InferSchemaType<typeof remoteMcpConnectionSchema>;
export const RemoteMcpConnectionModel = model<RemoteMcpConnection>("RemoteMcpConnection", remoteMcpConnectionSchema);
