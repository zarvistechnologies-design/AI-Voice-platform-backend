import { Schema, model, type InferSchemaType } from "mongoose";

const customVoiceSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    provider: { type: String, required: true, enum: ["sarvam"] },
    voiceId: { type: String, required: true, trim: true, maxlength: 128 },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    model: { type: String, required: true, enum: ["bulbul:v3"], default: "bulbul:v3" },
    language: { type: String, trim: true, maxlength: 80, default: "" },
    consentConfirmedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

customVoiceSchema.index(
  { ownerId: 1, provider: 1, voiceId: 1 },
  { unique: true },
);

export type CustomVoice = InferSchemaType<typeof customVoiceSchema>;
export const CustomVoiceModel = model<CustomVoice>("CustomVoice", customVoiceSchema);
