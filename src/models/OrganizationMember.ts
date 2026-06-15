import { Schema, model, type InferSchemaType } from "mongoose";

export const organizationRoles = ["owner", "admin", "member", "billing"] as const;
export type OrganizationRole = (typeof organizationRoles)[number];

const organizationMemberSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    role: { type: String, enum: organizationRoles, required: true },
    joinedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

organizationMemberSchema.index({ orgId: 1, userId: 1 }, { unique: true });
organizationMemberSchema.index({ userId: 1, createdAt: 1 });

export type OrganizationMember = InferSchemaType<typeof organizationMemberSchema>;
export const OrganizationMemberModel = model<OrganizationMember>(
  "OrganizationMember",
  organizationMemberSchema,
);
