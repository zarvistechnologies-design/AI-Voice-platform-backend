import { Schema, model, type InferSchemaType } from "mongoose";

export const outboundWebhookEvents = [
  "call.started",
  "call.ended",
  "call.failed",
  "transcript.ready",
] as const;
export type OutboundWebhookEvent = (typeof outboundWebhookEvents)[number];

const webhookEndpointSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    url: { type: String, required: true, trim: true, maxlength: 2000 },
    events: { type: [String], enum: outboundWebhookEvents, required: true },
    enabled: { type: Boolean, default: true },
    secretEncrypted: { type: String, required: true, select: false },
  },
  { timestamps: true },
);

webhookEndpointSchema.index({ orgId: 1, createdAt: -1 });

export type WebhookEndpoint = InferSchemaType<typeof webhookEndpointSchema>;
export const WebhookEndpointModel = model<WebhookEndpoint>("WebhookEndpoint", webhookEndpointSchema);
