import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

const knowledgeSourceSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    agentId: { type: Schema.Types.ObjectId, ref: "VoiceAgent", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    sourceType: {
      type: String,
      enum: ["text", "file", "url", "legacy"],
      required: true,
    },
    status: {
      type: String,
      enum: ["processing", "ready", "failed", "disabled"],
      default: "processing",
      index: true,
    },
    content: { type: String, required: true, maxlength: 2_000_000 },
    contentHash: { type: String, required: true, maxlength: 64 },
    originalFileName: { type: String, trim: true, maxlength: 255, default: "" },
    mimeType: { type: String, trim: true, maxlength: 160, default: "" },
    url: { type: String, trim: true, maxlength: 4000, default: "" },
    characterCount: { type: Number, min: 0, default: 0 },
    chunkCount: { type: Number, min: 0, default: 0 },
    embeddingModel: { type: String, trim: true, maxlength: 160, default: "" },
    error: { type: String, trim: true, maxlength: 1000, default: "" },
    legacyDocumentId: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

knowledgeSourceSchema.index({ ownerId: 1, agentId: 1, createdAt: -1 });
knowledgeSourceSchema.index(
  { agentId: 1, legacyDocumentId: 1 },
  { unique: true, partialFilterExpression: { sourceType: "legacy" } },
);

export type KnowledgeSource = InferSchemaType<typeof knowledgeSourceSchema>;
export type KnowledgeSourceDocument = HydratedDocument<KnowledgeSource>;

export const KnowledgeSourceModel = model<KnowledgeSource>("KnowledgeSource", knowledgeSourceSchema);
