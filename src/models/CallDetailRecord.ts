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
    campaignId: { type: Schema.Types.ObjectId, ref: "Campaign", default: null, index: true },
    campaignLeadId: { type: Schema.Types.ObjectId, ref: "CampaignLead", default: null, index: true },
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
    // A durable fail-closed guard for the non-transactional LiveKit/SIP setup.
    // Phone mutations remain blocked while this is true, even if the process
    // lease expires or campaign cancellation terminalizes the visible status.
    outboundSetupPending: { type: Boolean, default: false },
    outboundSetupToken: { type: String, trim: true, default: "", select: false },
    outboundSetupStage: {
      type: String,
      enum: [
        "",
        "starting",
        "preparing",
        "room_creating",
        "room_created",
        "dispatch_created",
        "dialing",
        "established",
        "aborted",
        "cleanup_required",
      ],
      default: "",
    },
    outboundSetupStartedAt: { type: Date },
    outboundSetupCompletedAt: { type: Date },
    // Terminal state and terminal side effects are separate durable steps.
    // The marker lets webhook/controller retries recover a process crash after
    // the status CAS without dispatching billing/webhooks concurrently.
    terminalFinalizationStatus: {
      type: String,
      enum: ["", "pending", "processing", "completed", "failed"],
      default: "",
      select: false,
    },
    terminalFinalizationToken: { type: String, trim: true, default: "", select: false },
    terminalFinalizationLeaseUntil: { type: Date, select: false },
    terminalFinalizationAttempts: { type: Number, min: 0, default: 0, select: false },
    terminalFinalizationError: { type: String, trim: true, default: "", select: false },
    terminalFinalizationDeferred: { type: Boolean, default: false, select: false },
    // Terminal inputs (usage, transcript, recording state) can arrive after
    // room_finished. The due timestamp debounces those events and the revision
    // invalidates an in-flight worker if newer data is persisted.
    terminalFinalizationDueAt: { type: Date, select: false },
    terminalDataRevision: { type: Number, min: 0, default: 0, select: false },
    // Changes only when provider-reported usage changes. Transcript, recording,
    // and intelligence revisions must never cause an already billed call to be
    // repriced against a newer catalog.
    billingUsageRevision: { type: Number, min: 0, default: 0, select: false },
    terminalFinalizedDataRevision: { type: Number, min: 0, default: 0, select: false },
    terminalRuntimeClosedAt: { type: Date, select: false },
    terminalFinalizedAt: { type: Date },
    postCallIntegrationsDispatchedAt: { type: Date, select: false },
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
    pipelineMode: { type: String, enum: ["pipeline", "realtime"], default: "pipeline" },
    realtimeProvider: { type: String, trim: true, default: "" },
    realtimeModel: { type: String, trim: true, default: "" },
    language: { type: String, trim: true, default: "" },
    llmProvider: { type: String, trim: true, default: "" },
    llmModel: { type: String, trim: true, default: "" },
    llmInputTokens: { type: Number, min: 0, default: 0 },
    llmOutputTokens: { type: Number, min: 0, default: 0 },
    llmTokens: { type: Number, min: 0, default: 0 },
    sttProvider: { type: String, trim: true, default: "" },
    sttModel: { type: String, trim: true, default: "" },
    sttInputTokens: { type: Number, min: 0, default: 0 },
    sttOutputTokens: { type: Number, min: 0, default: 0 },
    sttSeconds: { type: Number, min: 0, default: 0 },
    ttsProvider: { type: String, trim: true, default: "" },
    ttsModel: { type: String, trim: true, default: "" },
    ttsVoice: { type: String, trim: true, default: "" },
    ttsInputTokens: { type: Number, min: 0, default: 0 },
    ttsOutputTokens: { type: Number, min: 0, default: 0 },
    ttsAudioSeconds: { type: Number, min: 0, default: 0 },
    ttsCharacters: { type: Number, min: 0, default: 0 },
    modelUsage: { type: [Schema.Types.Mixed], default: [] },
    costBreakdown: {
      calculationVersion: { type: String, trim: true, default: "" },
      pricingStatus: {
        type: String,
        enum: ["exact", "estimated", "unpriced"],
        default: "unpriced",
      },
      missingPricing: { type: [Schema.Types.Mixed], default: [] },
      llm: { type: Number, min: 0, default: 0 },
      stt: { type: Number, min: 0, default: 0 },
      tts: { type: Number, min: 0, default: 0 },
      telephony: { type: Number, min: 0, default: 0 },
      providerCost: { type: Number, min: 0, default: 0 },
      platformFee: { type: Number, min: 0, default: 0 },
      platformFeeInrPerCall: { type: Number, min: 0, default: 1 },
      customerCost: { type: Number, min: 0, default: 0 },
      total: { type: Number, min: 0, default: 0 },
      currency: { type: String, trim: true, default: "USD" },
      pricing: { type: Schema.Types.Mixed, default: {} },
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
callDetailRecordSchema.index({ ownerId: 1, createdAt: -1 });
callDetailRecordSchema.index({ ownerId: 1, agentId: 1, startedAt: -1 });
callDetailRecordSchema.index({ ownerId: 1, agentId: 1, createdAt: -1 });
callDetailRecordSchema.index({ ownerId: 1, agentId: 1, status: 1, updatedAt: -1 });
callDetailRecordSchema.index({ ownerId: 1, status: 1, startedAt: -1 });
callDetailRecordSchema.index({ ownerId: 1, direction: 1, startedAt: -1 });
callDetailRecordSchema.index({ campaignId: 1, status: 1, startedAt: -1 });
callDetailRecordSchema.index({ phoneNumberId: 1, outboundSetupPending: 1 });
callDetailRecordSchema.index({ campaignId: 1, outboundSetupPending: 1 });
callDetailRecordSchema.index({
  terminalFinalizationStatus: 1,
  terminalFinalizationDeferred: 1,
  terminalFinalizationDueAt: 1,
  terminalFinalizationLeaseUntil: 1,
});
callDetailRecordSchema.index({ terminalFinalizationDeferred: 1, status: 1, updatedAt: 1 });

export type CallDetailRecord = InferSchemaType<typeof callDetailRecordSchema>;
export const CallDetailRecordModel = model<CallDetailRecord>(
  "CallDetailRecord",
  callDetailRecordSchema,
);
