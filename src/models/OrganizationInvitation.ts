import { Schema, model, type InferSchemaType } from "mongoose";

import { organizationRoles } from "./OrganizationMember.js";

const organizationInvitationSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 160 },
    role: { type: String, enum: organizationRoles.filter((role) => role !== "owner"), required: true },
    tokenHash: { type: String, required: true, unique: true, select: false },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "revoked", "expired"],
      default: "pending",
      index: true,
    },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    acceptedAt: { type: Date },
  },
  { timestamps: true },
);

organizationInvitationSchema.index({ orgId: 1, email: 1, status: 1 });

export type OrganizationInvitation = InferSchemaType<typeof organizationInvitationSchema>;
export const OrganizationInvitationModel = model<OrganizationInvitation>(
  "OrganizationInvitation",
  organizationInvitationSchema,
);
