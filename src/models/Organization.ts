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
    whiteLabelAccountId: { type: Schema.Types.ObjectId, ref: "WhiteLabelAccount", index: true },
    whiteLabelBrandId: { type: Schema.Types.ObjectId, ref: "WhiteLabelBrand", index: true },
    whiteLabelOwnerAccountId: { type: Schema.Types.ObjectId, ref: "WhiteLabelAccount", index: true },
    lifecycleStatus: {
      type: String,
      enum: ["active", "suspended", "archived"],
      default: "active",
      index: true,
    },
    provisioningSource: {
      type: String,
      enum: ["self_serve", "partner", "platform", "migration"],
      default: "self_serve",
    },
    externalCustomerId: { type: String, trim: true, default: "", maxlength: 200 },
    referralCode: { type: String, trim: true, uppercase: true, default: "", maxlength: 40 },
    businessDetailsRequired: { type: Boolean, default: false },
    plan: {
      type: String,
      enum: ["free", "starter", "growth", "enterprise"],
      default: "free",
    },
    settings: {
      timezone: { type: String, trim: true, default: "UTC" },
      dataRetentionDays: { type: Number, min: 1, max: 3650, default: 90 },
    },
    billingProfile: {
      gstin: { type: String, trim: true, uppercase: true, default: "", maxlength: 15 },
      address: { type: String, trim: true, default: "", maxlength: 500 },
      phone: { type: String, trim: true, default: "", maxlength: 30 },
      country: { type: String, trim: true, default: "", maxlength: 80 },
      state: { type: String, trim: true, default: "", maxlength: 100 },
      postalCode: { type: String, trim: true, default: "", maxlength: 20 },
    },
  },
  { timestamps: true },
);

organizationSchema.index({ ownerUserId: 1, createdAt: -1 });
organizationSchema.index({ whiteLabelAccountId: 1, lifecycleStatus: 1, createdAt: -1 });
organizationSchema.index(
  { whiteLabelAccountId: 1, externalCustomerId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      whiteLabelAccountId: { $exists: true },
      externalCustomerId: { $type: "string", $gt: "" },
    },
  },
);

export type Organization = InferSchemaType<typeof organizationSchema>;
export const OrganizationModel = model<Organization>("Organization", organizationSchema);
