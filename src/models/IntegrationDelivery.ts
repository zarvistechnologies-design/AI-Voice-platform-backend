import { Schema, model, type InferSchemaType } from "mongoose";

const integrationDeliverySchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    provider: { type: String, required: true, enum: ["hubspot", "slack"], index: true },
    eventId: { type: String, required: true },
    event: { type: String, required: true, enum: ["call.ended"] },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ["staged", "pending", "processing", "delivered", "retrying", "failed"],
      default: "pending",
      index: true,
    },
    deliveryToken: { type: String, trim: true, default: "", select: false },
    deliveryLeaseUntil: { type: Date, select: false },
    attempts: { type: Number, min: 0, default: 0 },
    errorMessage: { type: String, trim: true, default: "", maxlength: 2000 },
    nextAttemptAt: { type: Date, index: true },
    deliveredAt: { type: Date },
  },
  { timestamps: true },
);

integrationDeliverySchema.index({ ownerId: 1, provider: 1, eventId: 1 }, { unique: true });
integrationDeliverySchema.index({ status: 1, nextAttemptAt: 1 });
integrationDeliverySchema.index({ status: 1, deliveryLeaseUntil: 1 });
integrationDeliverySchema.index({ ownerId: 1, createdAt: -1 });

export type IntegrationDelivery = InferSchemaType<typeof integrationDeliverySchema>;
export const IntegrationDeliveryModel = model<IntegrationDelivery>(
  "IntegrationDelivery",
  integrationDeliverySchema,
);
