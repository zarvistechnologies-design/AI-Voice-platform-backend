import { Schema, model, type InferSchemaType } from "mongoose";

const nativeWorkflowRecordSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    agentId: { type: Schema.Types.ObjectId, ref: "VoiceAgent", required: true, index: true },
    callId: { type: String, trim: true, default: "", index: true },
    templateId: { type: String, required: true, trim: true, maxlength: 80, index: true },
    kind: { type: String, required: true, trim: true, maxlength: 80, index: true },
    status: { type: String, required: true, trim: true, maxlength: 80, index: true },
    reference: { type: String, required: true, unique: true, index: true },
    dedupeKey: { type: String, trim: true, default: "" },
    contactName: { type: String, trim: true, maxlength: 160, default: "" },
    contactPhone: { type: String, trim: true, maxlength: 40, default: "" },
    summary: { type: String, trim: true, maxlength: 500, default: "" },
    scheduledForText: { type: String, trim: true, maxlength: 160, default: "" },
    data: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

nativeWorkflowRecordSchema.index({ ownerId: 1, agentId: 1, createdAt: -1 });
nativeWorkflowRecordSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string", $gt: "" } } });

export type NativeWorkflowRecord = InferSchemaType<typeof nativeWorkflowRecordSchema>;
export const NativeWorkflowRecordModel = model<NativeWorkflowRecord>("NativeWorkflowRecord", nativeWorkflowRecordSchema);
