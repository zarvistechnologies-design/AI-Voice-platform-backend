import { Schema, model, type InferSchemaType } from "mongoose";

const digitalBotAgentConnectionSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    targetAgentId: { type: String, required: true, trim: true },
    targetAgentName: { type: String, trim: true, default: "" },
    displayName: { type: String, trim: true, default: "" },
    accountId: { type: String, required: true, trim: true },
    secretEncrypted: { type: String, required: true, select: false },
    status: { type: String, enum: ["connected", "error"], default: "connected" },
    lastVerifiedAt: { type: Date, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

digitalBotAgentConnectionSchema.index({ ownerId: 1, targetAgentId: 1 }, { unique: true });

export type DigitalBotAgentConnection = InferSchemaType<typeof digitalBotAgentConnectionSchema>;
export const DigitalBotAgentConnectionModel = model<DigitalBotAgentConnection>(
  "DigitalBotAgentConnection",
  digitalBotAgentConnectionSchema,
);
