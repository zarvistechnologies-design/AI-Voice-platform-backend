import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const providerModels = [
  "openai-realtime",
  "gemini-live",
  "sarvam-gemini",
] as const;

export const voiceAgentLimits = {
  prompt: 30000,
  firstMessage: 2000,
} as const;

const toolParameterSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    type: {
      type: String,
      enum: ["string", "number", "boolean", "object"],
      default: "string",
    },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    required: { type: Boolean, default: false },
  },
  { _id: true },
);

const extractionFieldSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 80 },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    type: {
      type: String,
      enum: ["string", "number", "boolean", "date", "enum"],
      default: "string",
    },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    required: { type: Boolean, default: false },
    options: { type: [String], default: [] },
  },
  { _id: true },
);

const voiceAgentSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    team: { type: String, required: true, trim: true, maxlength: 120 },
    status: {
      type: String,
      enum: ["Live", "Draft", "Paused"],
      default: "Draft",
    },
    phone: { type: String, trim: true, default: "" },
    language: { type: String, trim: true, default: "English" },
    voice: { type: String, trim: true, default: "alloy" },
    pipelineMode: {
      type: String,
      enum: ["realtime", "pipeline"],
      default: "realtime",
    },
    realtimeProvider: {
      type: String,
      enum: ["openai", "gemini"],
      default: "openai",
    },
    realtimeModel: { type: String, trim: true, default: "gpt-realtime" },
    llmProvider: {
      type: String,
      enum: ["openai", "gemini", "sarvam"],
      default: "openai",
    },
    llmModel: { type: String, trim: true, default: "gpt-4.1-mini" },
    sttProvider: {
      type: String,
      enum: ["openai", "sarvam", "elevenlabs"],
      default: "openai",
    },
    sttModel: { type: String, trim: true, default: "gpt-4o-mini-transcribe" },
    ttsProvider: {
      type: String,
      enum: ["openai", "gemini", "sarvam", "elevenlabs"],
      default: "openai",
    },
    ttsModel: { type: String, trim: true, default: "gpt-4o-mini-tts" },
    temperature: { type: Number, min: 0, max: 2, default: 0.35 },
    maxConcurrentCalls: { type: Number, min: 1, max: 100, default: 5 },
    voiceSpeed: { type: Number, min: 0.5, max: 2, default: 1 },
    voicePitch: { type: Number, min: -10, max: 10, default: 0 },
    interruptionSensitivity: { type: String, enum: ["low", "medium", "high"], default: "medium" },
    backgroundNoise: { type: String, enum: ["none", "office", "cafe", "street"], default: "none" },
    callbackEmail: { type: String, trim: true, default: "", maxlength: 160 },
    businessHoursEnabled: { type: Boolean, default: false },
    businessHours: {
      timezone: { type: String, trim: true, default: "UTC" },
      schedule: {
        type: [
          new Schema(
            {
              day: { type: String, enum: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], required: true },
              enabled: { type: Boolean, default: true },
              start: { type: String, default: "09:00" },
              end: { type: String, default: "17:00" },
            },
            { _id: false },
          ),
        ],
        default: [],
      },
    },
    providerModel: {
      type: String,
      enum: providerModels,
      default: "openai-realtime",
    },
    prompt: { type: String, required: true, maxlength: voiceAgentLimits.prompt },
    firstMessage: { type: String, required: true, maxlength: voiceAgentLimits.firstMessage },
    firstMessageMode: {
      type: String,
      enum: ["assistant-speaks-first", "user-speaks-first", "model-generated"],
      default: "assistant-speaks-first",
    },
    behavior: {
      interruptions: { type: Boolean, default: true },
      userStartsFirst: { type: Boolean, default: false },
      autoFillResponses: { type: Boolean, default: true },
      agentCanTerminate: { type: Boolean, default: true },
      voicemailHandling: { type: Boolean, default: true },
      voicemailAction: {
        type: String,
        enum: ["leave-message", "hangup"],
        default: "leave-message",
      },
      dtmfDial: { type: Boolean, default: false },
      dtmfSequence: { type: String, trim: true, maxlength: 80, default: "" },
      endpointingMode: {
        type: String,
        enum: ["fast", "balanced", "patient"],
        default: "balanced",
      },
      responseDelayMs: { type: Number, min: 0, max: 5000, default: 180 },
      maxCallDurationSeconds: { type: Number, min: 30, max: 7200, default: 1200 },
      maxIdleSeconds: { type: Number, min: 60, max: 600, default: 60 },
      transferPhone: { type: String, trim: true, default: "" },
      timezone: { type: String, trim: true, default: "UTC" },
      voicemailMessage: {
        type: String,
        trim: true,
        maxlength: 2000,
        default: "Sorry we missed you. Please leave a message after the tone.",
      },
    },
    callSettings: {
      recordingEnabled: { type: Boolean, default: false },
      doNotCallDetection: { type: Boolean, default: true },
      sessionContinuation: { type: Boolean, default: true },
      memoryEnabled: { type: Boolean, default: true },
    },
    tools: {
      type: [
        new Schema(
          {
            name: { type: String, required: true, trim: true, maxlength: 80 },
            description: { type: String, trim: true, maxlength: 500, default: "" },
            method: {
              type: String,
              enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
              default: "POST",
            },
            url: { type: String, required: true, trim: true, maxlength: 2000 },
            headers: { type: Schema.Types.Mixed, default: {} },
            timeoutSeconds: { type: Number, min: 1, max: 30, default: 8 },
            enabled: { type: Boolean, default: true },
            parameters: { type: [toolParameterSchema], default: [] },
            runAfterCall: { type: Boolean, default: false },
            executeAfterMessage: { type: Boolean, default: false },
            excludeSessionId: { type: Boolean, default: true },
            messages: { type: [String], default: [] },
          },
          { _id: true },
        ),
      ],
      default: [],
    },
    knowledgeDocuments: {
      type: [
        new Schema(
          {
            name: { type: String, required: true, trim: true, maxlength: 160 },
            content: { type: String, required: true, maxlength: 100000 },
            status: { type: String, enum: ["ready", "disabled"], default: "ready" },
          },
          { _id: true, timestamps: true },
        ),
      ],
      default: [],
    },
    dynamicVariables: { type: [String], default: ["FromPhone", "ToPhone"] },
    prefetchWebhook: { type: String, trim: true, default: "", maxlength: 2000 },
    endOfCallWebhook: { type: String, trim: true, default: "", maxlength: 2000 },
    analysisPlan: {
      enabled: { type: Boolean, default: true },
      fields: {
        type: [extractionFieldSchema],
        default: [
          { key: "outcome", label: "Outcome", type: "enum", options: ["qualified", "follow_up", "resolved", "missed", "not_interested"] },
          { key: "caller_name", label: "Caller name", type: "string" },
          { key: "intent", label: "Intent", type: "string" },
          { key: "priority", label: "Priority", type: "enum", options: ["low", "medium", "high", "urgent"] },
          { key: "next_step", label: "Next step", type: "string" },
        ],
      },
    },
    widget: {
      enabled: { type: Boolean, default: false },
      publicKey: { type: String, trim: true, default: "" },
      allowedDomains: { type: [String], default: [] },
      theme: { type: String, enum: ["light", "dark", "auto"], default: "auto" },
      position: {
        type: String,
        enum: ["bottom-right", "bottom-left", "inline"],
        default: "bottom-right",
      },
      buttonText: { type: String, trim: true, maxlength: 60, default: "Talk to us" },
      accentColor: { type: String, trim: true, default: "#1438f5" },
    },
    version: { type: Number, min: 1, default: 1 },
    latencyMetrics: {
      latestMs: { type: Number, min: 0 },
      averageMs: { type: Number, min: 0 },
      sampleCount: { type: Number, min: 0, default: 0 },
      lastMeasuredAt: { type: Date },
    },
  },
  { timestamps: true },
);

voiceAgentSchema.index({ ownerId: 1, status: 1 });
voiceAgentSchema.index({ ownerId: 1, createdAt: -1 });

export type VoiceAgent = InferSchemaType<typeof voiceAgentSchema>;
export type VoiceAgentDocument = HydratedDocument<VoiceAgent>;

export const VoiceAgentModel = model<VoiceAgent>("VoiceAgent", voiceAgentSchema);
