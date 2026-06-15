import { Schema, model, type InferSchemaType } from "mongoose";

const authSessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    tokenId: { type: String, required: true, unique: true },
    device: { type: String, trim: true, default: "Unknown device", maxlength: 500 },
    ip: { type: String, trim: true, default: "" },
    lastSeenAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
  },
  { timestamps: true },
);

authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
authSessionSchema.index({ userId: 1, createdAt: -1 });

export type AuthSession = InferSchemaType<typeof authSessionSchema>;
export const AuthSessionModel = model<AuthSession>("AuthSession", authSessionSchema);
