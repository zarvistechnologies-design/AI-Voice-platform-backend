import { Schema, model, type InferSchemaType } from "mongoose";

const contactSuppressionSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    phone: { type: String, required: true, trim: true },
    reason: { type: String, required: true, trim: true, maxlength: 500, default: "Opted out" },
    source: { type: String, trim: true, maxlength: 120, default: "manual" },
    createdBy: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

contactSuppressionSchema.index({ ownerId: 1, phone: 1 }, { unique: true });
contactSuppressionSchema.index({ ownerId: 1, createdAt: -1 });

export type ContactSuppression = InferSchemaType<typeof contactSuppressionSchema>;
export const ContactSuppressionModel = model<ContactSuppression>("ContactSuppression", contactSuppressionSchema);
