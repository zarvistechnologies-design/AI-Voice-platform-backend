import { Schema, model, type InferSchemaType } from "mongoose";

const webhookDeliverySchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    webhookId: { type: Schema.Types.ObjectId, ref: "WebhookEndpoint", required: true, index: true },
    eventId: { type: String, required: true },
    event: { type: String, required: true, trim: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: ["pending", "delivered", "retrying", "failed"], default: "pending", index: true },
    attempts: { type: Number, min: 0, default: 0 },
    responseStatus: { type: Number, min: 0, default: 0 },
    responseBody: { type: String, default: "", maxlength: 4000 },
    durationMs: { type: Number, min: 0, default: 0 },
    errorMessage: { type: String, default: "", maxlength: 2000 },
    nextAttemptAt: { type: Date, index: true },
    deliveredAt: { type: Date },
  },
  { timestamps: true },
);

webhookDeliverySchema.index({ webhookId: 1, eventId: 1 }, { unique: true });
webhookDeliverySchema.index({ orgId: 1, createdAt: -1 });

export type WebhookDelivery = InferSchemaType<typeof webhookDeliverySchema>;
export const WebhookDeliveryModel = model<WebhookDelivery>("WebhookDelivery", webhookDeliverySchema);
