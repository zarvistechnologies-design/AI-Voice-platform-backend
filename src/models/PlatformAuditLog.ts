import { Schema, model, type InferSchemaType } from "mongoose";

const platformAuditLogSchema = new Schema(
  {
    actorType: { type: String, enum: ["user", "system"], default: "user", index: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    actorEmail: { type: String, trim: true, lowercase: true, default: "" },
    action: { type: String, required: true, trim: true, index: true },
    resource: { type: String, required: true, trim: true, index: true },
    resourceId: { type: String, trim: true, default: "", index: true },
    accountId: { type: Schema.Types.ObjectId, ref: "WhiteLabelAccount", index: true },
    targetOrgId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
    reason: { type: String, trim: true, default: "", maxlength: 2_000 },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    requestId: { type: String, trim: true, default: "", index: true },
    ip: { type: String, trim: true, default: "" },
    userAgent: { type: String, trim: true, default: "", maxlength: 1_000 },
  },
  { timestamps: true, versionKey: false },
);

platformAuditLogSchema.index({ createdAt: -1 });
platformAuditLogSchema.index({ accountId: 1, createdAt: -1 });
platformAuditLogSchema.index({ actorUserId: 1, createdAt: -1 });

export type PlatformAuditLog = InferSchemaType<typeof platformAuditLogSchema>;
export const PlatformAuditLogModel = model<PlatformAuditLog>(
  "PlatformAuditLog",
  platformAuditLogSchema,
);
