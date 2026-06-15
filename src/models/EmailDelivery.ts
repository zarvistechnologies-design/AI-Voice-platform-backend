import { Schema, model, type InferSchemaType } from "mongoose";

const emailDeliverySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    to: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true },
    kind: { type: String, enum: ["verification", "password-reset", "security"], required: true },
    status: { type: String, enum: ["sent", "preview", "failed"], required: true },
    providerId: { type: String, trim: true, default: "" },
    errorMessage: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

export type EmailDelivery = InferSchemaType<typeof emailDeliverySchema>;
export const EmailDeliveryModel = model<EmailDelivery>("EmailDelivery", emailDeliverySchema);
