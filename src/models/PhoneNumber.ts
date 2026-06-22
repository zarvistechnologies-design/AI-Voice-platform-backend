import { Schema, model, type InferSchemaType } from "mongoose";

const phoneNumberSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    number: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    direction: {
      type: String,
      enum: ["Inbound", "Outbound", "Both"],
      default: "Both",
    },
    region: { type: String, trim: true, default: "United States" },
    agentId: {
      type: Schema.Types.ObjectId,
      ref: "VoiceAgent",
      default: null,
      required(this: { status?: string }) {
        return this.status === "Ready";
      },
    },
    inboundTrunkId: { type: String, trim: true, default: "" },
    outboundTrunkId: { type: String, trim: true, default: "" },
    dispatchRuleId: { type: String, trim: true, default: "" },
    provider: { type: String, enum: ["Twilio", "Exotel", "Vobiz"], trim: true, default: "Vobiz" },
    providerNumberId: { type: String, trim: true, default: "" },
    monthlyFee: { type: Number, min: 0, default: 0 },
    currency: { type: String, trim: true, default: "INR" },
    status: {
      type: String,
      enum: ["Ready", "Pending", "Needs setup"],
      default: "Pending",
    },
  },
  { timestamps: true },
);

phoneNumberSchema.index({ ownerId: 1, number: 1 }, { unique: true });
phoneNumberSchema.index({ ownerId: 1, agentId: 1, status: 1 });

export type PhoneNumber = InferSchemaType<typeof phoneNumberSchema>;
export const PhoneNumberModel = model<PhoneNumber>("PhoneNumber", phoneNumberSchema);
