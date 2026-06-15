import { Schema, model, type InferSchemaType } from "mongoose";

const auditLogSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    actorEmail: { type: String, trim: true, default: "" },
    action: { type: String, required: true, trim: true, maxlength: 120, index: true },
    resource: { type: String, required: true, trim: true, maxlength: 80, index: true },
    resourceId: { type: String, trim: true, default: "", index: true },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    ip: { type: String, trim: true, default: "" },
    userAgent: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

auditLogSchema.index({ orgId: 1, createdAt: -1 });
auditLogSchema.index({ orgId: 1, resource: 1, createdAt: -1 });
auditLogSchema.index({ orgId: 1, userId: 1, createdAt: -1 });

export type AuditLog = InferSchemaType<typeof auditLogSchema>;
export const AuditLogModel = model<AuditLog>("AuditLog", auditLogSchema);
