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
      enum: ["openai", "sarvam"],
      default: "openai",
    },
    sttModel: { type: String, trim: true, default: "gpt-4o-mini-transcribe" },
    ttsProvider: {
      type: String,
      enum: ["openai", "gemini", "sarvam"],
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
    behavior: {
      interruptions: { type: Boolean, default: true },
      userStartsFirst: { type: Boolean, default: false },
      autoFillResponses: { type: Boolean, default: true },
      agentCanTerminate: { type: Boolean, default: true },
      voicemailHandling: { type: Boolean, default: true },
      dtmfDial: { type: Boolean, default: false },
      responseDelayMs: { type: Number, min: 0, max: 5000, default: 180 },
      maxCallDurationSeconds: { type: Number, min: 30, max: 7200, default: 1200 },
      maxIdleSeconds: { type: Number, min: 5, max: 600, default: 18 },
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
            timeoutSeconds: { type: Number, min: 1, max: 30, default: 8 },
            enabled: { type: Boolean, default: true },
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
