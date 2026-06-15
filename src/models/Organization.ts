import { Schema, model, type InferSchemaType } from "mongoose";

const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: 2,
      maxlength: 80,
    },
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    plan: {
      type: String,
      enum: ["free", "starter", "growth", "enterprise"],
      default: "free",
    },
    settings: {
      timezone: { type: String, trim: true, default: "UTC" },
      dataRetentionDays: { type: Number, min: 1, max: 3650, default: 90 },
    },
  },
  { timestamps: true },
);

organizationSchema.index({ ownerUserId: 1, createdAt: -1 });

export type Organization = InferSchemaType<typeof organizationSchema>;
export const OrganizationModel = model<Organization>("Organization", organizationSchema);
