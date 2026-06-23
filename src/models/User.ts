import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

const userSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 80,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 160,
    },
    passwordHash: {
      type: String,
      default: "",
      select: false,
    },
    googleSubject: {
      type: String,
      unique: true,
      sparse: true,
      select: false,
    },
    emailVerified: { type: Boolean, default: false },
    verificationTokenHash: { type: String, default: "", select: false },
    passwordResetTokenHash: { type: String, default: "", select: false },
    passwordResetExpires: { type: Date },
    twoFactorSecretEncrypted: { type: String, default: "", select: false },
    twoFactorEnabled: { type: Boolean, default: false },
    loginAttempts: { type: Number, min: 0, default: 0 },
    lockUntil: { type: Date },
    lastLoginAt: { type: Date },
    lastLoginIp: { type: String, trim: true, default: "" },
  },
  {
    timestamps: true,
  },
);

export type User = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<User>;

export type PublicUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt?: Date | null;
  createdAt: Date;
};

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    twoFactorEnabled: user.twoFactorEnabled,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

export const UserModel = model<User>("User", userSchema);
