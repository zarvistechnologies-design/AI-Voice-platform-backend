import { Schema, model, type InferSchemaType } from "mongoose";

const dnsRecordSchema = new Schema(
  {
    type: { type: String, enum: ["TXT", "CNAME"], required: true },
    name: { type: String, required: true, trim: true, lowercase: true },
    value: { type: String, required: true, trim: true },
    purpose: {
      type: String,
      enum: ["ownership", "routing", "certificate"],
      required: true,
    },
  },
  { _id: false },
);

const whiteLabelDomainSchema = new Schema(
  {
    accountId: {
      type: Schema.Types.ObjectId,
      ref: "WhiteLabelAccount",
      required: true,
      index: true,
    },
    brandId: {
      type: Schema.Types.ObjectId,
      ref: "WhiteLabelBrand",
      required: true,
      index: true,
    },
    hostname: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 253,
    },
    kind: { type: String, enum: ["app", "api", "link"], default: "app" },
    status: {
      type: String,
      enum: [
        "pending",
        "verifying",
        "awaiting_dns",
        "awaiting_certificate",
        "active",
        "failed",
        "disabled",
      ],
      default: "pending",
      index: true,
    },
    verificationToken: { type: String, required: true, trim: true, select: false },
    requiredRecords: { type: [dnsRecordSchema], default: [] },
    ownershipVerifiedAt: { type: Date },
    routingVerifiedAt: { type: Date },
    lastCheckedAt: { type: Date },
    nextCheckAt: { type: Date, index: true },
    failureReason: { type: String, trim: true, default: "", maxlength: 1_000 },
    tls: {
      status: {
        type: String,
        enum: ["not_started", "pending_validation", "pending_issuance", "active", "failed"],
        default: "not_started",
      },
      issuer: { type: String, trim: true, default: "" },
      expiresAt: { type: Date },
      minimumVersion: { type: String, enum: ["1.2", "1.3"], default: "1.2" },
    },
    edge: {
      provider: { type: String, enum: ["none", "cloudflare"], default: "none" },
      providerHostnameId: { type: String, trim: true, default: "", select: false },
      hostnameStatus: { type: String, trim: true, default: "" },
      lastSyncedAt: { type: Date },
    },
    activatedAt: { type: Date },
    disabledAt: { type: Date },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
    versionKey: "revision",
  },
);

whiteLabelDomainSchema.index({ accountId: 1, brandId: 1, kind: 1, createdAt: -1 });
whiteLabelDomainSchema.index({ status: 1, nextCheckAt: 1 });

export type WhiteLabelDomain = InferSchemaType<typeof whiteLabelDomainSchema>;
export const WhiteLabelDomainModel = model<WhiteLabelDomain>(
  "WhiteLabelDomain",
  whiteLabelDomainSchema,
);

