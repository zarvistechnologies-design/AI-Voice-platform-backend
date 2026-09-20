import { Schema, model, type InferSchemaType } from "mongoose";

const nativeAppointmentSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    agentId: { type: Schema.Types.ObjectId, ref: "VoiceAgent", required: true, index: true },
    callId: { type: String, trim: true, default: "", index: true },
    provider: { type: String, required: true, trim: true, maxlength: 160 },
    providerKey: { type: String, required: true, trim: true, maxlength: 160 },
    patientName: { type: String, required: true, trim: true, maxlength: 160 },
    patientPhone: { type: String, required: true, trim: true, maxlength: 40 },
    appointmentType: { type: String, trim: true, maxlength: 160, default: "Consultation" },
    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    timezone: { type: String, required: true, trim: true, maxlength: 100 },
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, required: true },
    bookingReference: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ["booked", "cancelled"], default: "booked", index: true },
  },
  { timestamps: true },
);

nativeAppointmentSchema.index(
  { agentId: 1, providerKey: 1, startAt: 1 },
  { unique: true, partialFilterExpression: { status: "booked" } },
);
nativeAppointmentSchema.index({ ownerId: 1, agentId: 1, startAt: 1 });

export type NativeAppointment = InferSchemaType<typeof nativeAppointmentSchema>;
export const NativeAppointmentModel = model<NativeAppointment>("NativeAppointment", nativeAppointmentSchema);
