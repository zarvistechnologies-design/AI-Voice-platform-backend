import { Schema, model, type InferSchemaType } from "mongoose";

const whiteLabelBrandSchema = new Schema(
  {
    accountId: {
      type: Schema.Types.ObjectId,
      ref: "WhiteLabelAccount",
      required: true,
      index: true,
    },
    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      minlength: 2,
      maxlength: 80,
    },
    status: {
      type: String,
      enum: ["draft", "published", "disabled"],
      default: "draft",
      index: true,
    },
    isDefault: { type: Boolean, default: false },
    branding: {
      productName: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
      companyName: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
      logoUrl: { type: String, trim: true, default: "", maxlength: 2_000 },
      logoDarkUrl: { type: String, trim: true, default: "", maxlength: 2_000 },
      iconUrl: { type: String, trim: true, default: "", maxlength: 2_000 },
      primaryColor: { type: String, trim: true, default: "#45ddce", maxlength: 9 },
      secondaryColor: { type: String, trim: true, default: "#071b18", maxlength: 9 },
      accentColor: { type: String, trim: true, default: "#75fff0", maxlength: 9 },
      surfaceColor: { type: String, trim: true, default: "#020807", maxlength: 9 },
      defaultTheme: { type: String, enum: ["light", "dark", "system"], default: "dark" },
      poweredByText: { type: String, trim: true, default: "Powered by Vozon", maxlength: 120 },
    },
    support: {
      email: { type: String, trim: true, lowercase: true, default: "", maxlength: 160 },
      phone: { type: String, trim: true, default: "", maxlength: 40 },
      websiteUrl: { type: String, trim: true, default: "", maxlength: 2_000 },
      helpCenterUrl: { type: String, trim: true, default: "", maxlength: 2_000 },
      statusPageUrl: { type: String, trim: true, default: "", maxlength: 2_000 },
    },
    legal: {
      termsUrl: { type: String, trim: true, default: "", maxlength: 2_000 },
      privacyUrl: { type: String, trim: true, default: "", maxlength: 2_000 },
      cookiePolicyUrl: { type: String, trim: true, default: "", maxlength: 2_000 },
      legalBusinessName: { type: String, trim: true, default: "", maxlength: 160 },
      businessAddress: { type: String, trim: true, default: "", maxlength: 500 },
    },
    email: {
      fromName: { type: String, trim: true, default: "", maxlength: 120 },
      fromAddress: { type: String, trim: true, lowercase: true, default: "", maxlength: 160 },
      replyTo: { type: String, trim: true, lowercase: true, default: "", maxlength: 160 },
      sendingDomainStatus: {
        type: String,
        enum: ["not_configured", "pending", "verified", "failed"],
        default: "not_configured",
      },
    },
    publishedAt: { type: Date },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
    versionKey: "revision",
  },
);

whiteLabelBrandSchema.index({ accountId: 1, key: 1 }, { unique: true });
whiteLabelBrandSchema.index(
  { accountId: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
);
whiteLabelBrandSchema.index({ accountId: 1, status: 1, createdAt: -1 });

export type WhiteLabelBrand = InferSchemaType<typeof whiteLabelBrandSchema>;
export const WhiteLabelBrandModel = model<WhiteLabelBrand>("WhiteLabelBrand", whiteLabelBrandSchema);

