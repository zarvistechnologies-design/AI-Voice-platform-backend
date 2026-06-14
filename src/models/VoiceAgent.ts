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
    providerModel: {
      type: String,
      enum: providerModels,
      default: "openai-realtime",
    },
    prompt: { type: String, required: true, maxlength: voiceAgentLimits.prompt },
    firstMessage: { type: String, required: true, maxlength: voiceAgentLimits.firstMessage },
  },
  { timestamps: true },
);

export type VoiceAgent = InferSchemaType<typeof voiceAgentSchema>;
export type VoiceAgentDocument = HydratedDocument<VoiceAgent>;

export const VoiceAgentModel = model<VoiceAgent>("VoiceAgent", voiceAgentSchema);
