import { Schema, model, type InferSchemaType } from "mongoose";

const razorpayWebhookEventSchema = new Schema(
  {
    digest: { type: String, required: true, unique: true, index: true },
    event: { type: String, required: true, trim: true, index: true },
    status: { type: String, enum: ["processing", "processed", "failed"], default: "processing", index: true },
    attempts: { type: Number, min: 1, default: 1 },
    errorMessage: { type: String, trim: true, default: "" },
    processedAt: { type: Date },
  },
  { timestamps: true },
);

export type RazorpayWebhookEvent = InferSchemaType<typeof razorpayWebhookEventSchema>;
export const RazorpayWebhookEventModel = model<RazorpayWebhookEvent>("RazorpayWebhookEvent", razorpayWebhookEventSchema);
