import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

const knowledgeChunkSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    agentId: { type: Schema.Types.ObjectId, ref: "VoiceAgent", required: true, index: true },
    sourceId: { type: Schema.Types.ObjectId, ref: "KnowledgeSource", required: true, index: true },
    sourceName: { type: String, required: true, trim: true, maxlength: 200 },
    chunkIndex: { type: Number, required: true, min: 0 },
    content: { type: String, required: true, maxlength: 12_000 },
    characterCount: { type: Number, min: 0, default: 0 },
    embeddingModel: { type: String, required: true, index: true, maxlength: 200 },
    embedding: { type: [Number], required: true, select: false },
  },
  { timestamps: true },
);

knowledgeChunkSchema.index({ ownerId: 1, agentId: 1, sourceId: 1, chunkIndex: 1 }, { unique: true });

export type KnowledgeChunk = InferSchemaType<typeof knowledgeChunkSchema>;
export type KnowledgeChunkDocument = HydratedDocument<KnowledgeChunk>;

export const KnowledgeChunkModel = model<KnowledgeChunk>("KnowledgeChunk", knowledgeChunkSchema);
