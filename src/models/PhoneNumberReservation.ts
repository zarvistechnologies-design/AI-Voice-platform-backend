import { Schema, model, type InferSchemaType } from "mongoose";

const phoneNumberReservationSchema = new Schema(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    token: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "purchase-unconfirmed", "purchase-confirmed", "active"],
      required: true,
    },
    operation: { type: String, enum: ["import", "purchase"], default: "import" },
    idempotencyKey: { type: String, required: true },
    providerNumber: { type: Schema.Types.Mixed, default: null },
    phoneNumberId: { type: Schema.Types.ObjectId, ref: "PhoneNumber", default: null },
    expiresAt: { type: Date, default: null },
    cleanupAt: { type: Date, default: null },
  },
  {
    _id: false,
    timestamps: true,
    versionKey: false,
  },
);

// Lease expiry is evaluated synchronously. TTL only removes abandoned ordinary
// imports after a day; purchase outcomes and active ownership never TTL away.
phoneNumberReservationSchema.index(
  { cleanupAt: 1 },
  {
    expireAfterSeconds: 0,
    partialFilterExpression: { status: "pending", operation: "import" },
  },
);

export type PhoneNumberReservation = InferSchemaType<typeof phoneNumberReservationSchema>;
export const PhoneNumberReservationModel = model<PhoneNumberReservation>(
  "PhoneNumberReservation",
  phoneNumberReservationSchema,
);
