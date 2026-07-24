import { Schema, model, type InferSchemaType } from "mongoose";

const customerCaseSchema = new Schema(
  {
    caseNumber: { type: String, required: true, unique: true, index: true },
    type: { type: String, enum: ["service", "support"], required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, trim: true, maxlength: 20 },
    email: { type: String, trim: true, lowercase: true, maxlength: 160, default: "" },
    service: { type: String, trim: true, maxlength: 80, default: "" },
    company: { type: String, trim: true, maxlength: 120, default: "" },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    sourcePage: { type: String, trim: true, maxlength: 300, default: "" },
    status: { type: String, enum: ["new", "contacted", "resolved"], default: "new", index: true },
    emailStatus: { type: String, enum: ["pending", "sent", "preview", "failed"], default: "pending" },
    emailDeliveryId: { type: Schema.Types.ObjectId, ref: "EmailDelivery" },
    requestIp: { type: String, trim: true, default: "", select: false },
    userAgent: { type: String, trim: true, maxlength: 500, default: "", select: false },
  },
  { timestamps: true },
);

customerCaseSchema.index({ createdAt: -1 });
customerCaseSchema.index({ phone: 1, createdAt: -1 });

export type CustomerCase = InferSchemaType<typeof customerCaseSchema>;
export const CustomerCaseModel = model<CustomerCase>("CustomerCase", customerCaseSchema);
