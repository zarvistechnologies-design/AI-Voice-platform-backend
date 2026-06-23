import { Schema, model, type InferSchemaType } from "mongoose";

const transcriptItemSchema = new Schema(
  {
    itemId: { type: String, required: true },
    role: {
      type: String,
      enum: ["user", "assistant", "system"],
      required: true,
    },
    text: { type: String, required: true, maxlength: 20000 },
    timestamp: { type: Date, required: true },
    interrupted: { type: Boolean, default: false },
  },
  { _id: false },
);

const callDetailRecordSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    orgId: { type: String, trim: true, default: "", index: true },
    agentId: { type: Schema.Types.ObjectId, ref: "VoiceAgent", required: true, index: true },
    phoneNumberId: { type: Schema.Types.ObjectId, ref: "PhoneNumber" },
    direction: {
      type: String,
      enum: ["web", "inbound", "outbound"],
      required: true,
    },
    status: {
      type: String,
      enum: ["initiated", "ringing", "active", "completed", "failed", "cancelled"],
      default: "initiated",
      index: true,
    },
    callerNumber: { type: String, trim: true, default: "" },
    calledNumber: { type: String, trim: true, default: "" },
    livekitRoomName: { type: String, required: true, unique: true, index: true },
    livekitDispatchId: { type: String, trim: true, default: "" },
    livekitParticipantId: { type: String, trim: true, default: "" },
    startedAt: { type: Date },
    endedAt: { type: Date },
    durationSeconds: { type: Number, min: 0, default: 0 },
    transcript: { type: [transcriptItemSchema], default: [] },
    recordingKey: { type: String, trim: true, default: "" },
    recordingUrl: { type: String, trim: true, default: "" },
    recordingEgressId: { type: String, trim: true, default: "" },
    recordingStatus: {
      type: String,
      enum: ["", "starting", "active", "completed", "failed"],
      default: "",
    },
    recordingError: { type: String, trim: true, default: "" },
    recordingDuration: { type: Number, min: 0, default: 0 },
    llmProvider: { type: String, trim: true, default: "" },
    llmTokens: { type: Number, min: 0, default: 0 },
    sttProvider: { type: String, trim: true, default: "" },
    sttSeconds: { type: Number, min: 0, default: 0 },
    ttsProvider: { type: String, trim: true, default: "" },
    ttsCharacters: { type: Number, min: 0, default: 0 },
    costBreakdown: {
      llm: { type: Number, min: 0, default: 0 },
      stt: { type: Number, min: 0, default: 0 },
      tts: { type: Number, min: 0, default: 0 },
      telephony: { type: Number, min: 0, default: 0 },
      total: { type: Number, min: 0, default: 0 },
      currency: { type: String, trim: true, default: "USD" },
    },
    latencyTotalMs: { type: Number, min: 0, default: 0, select: false },
    latencySampleCount: { type: Number, min: 0, default: 0, select: false },
    avgResponseLatencyMs: { type: Number, min: 0, default: 0 },
    sentimentScore: { type: Number, min: -1, max: 1 },
    sentimentLabel: {
      type: String,
      enum: ["positive", "neutral", "negative", ""],
      default: "",
    },
    structuredOutput: { type: Schema.Types.Mixed, default: {} },
    structuredOutputStatus: {
      type: String,
      enum: ["", "pending", "completed", "skipped", "failed"],
      default: "",
    },
    structuredOutputError: { type: String, trim: true, default: "" },
    voicemailDetected: { type: Boolean, default: false },
    endReason: { type: String, trim: true, default: "" },
    errorMessage: { type: String, trim: true, default: "" },
    tags: { type: [String], default: [] },
  },
  { timestamps: true },
);

callDetailRecordSchema.index({ ownerId: 1, startedAt: -1 });
callDetailRecordSchema.index({ ownerId: 1, agentId: 1, startedAt: -1 });
callDetailRecordSchema.index({ ownerId: 1, status: 1, startedAt: -1 });
callDetailRecordSchema.index({ ownerId: 1, direction: 1, startedAt: -1 });

export type CallDetailRecord = InferSchemaType<typeof callDetailRecordSchema>;
export const CallDetailRecordModel = model<CallDetailRecord>(
  "CallDetailRecord",
  callDetailRecordSchema,
);
