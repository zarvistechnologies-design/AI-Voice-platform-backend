import { Schema, model, type InferSchemaType } from "mongoose";

const assistantPendingActionSchema = new Schema({
  ownerId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  toolName: { type: String, enum: ["create_agent", "update_agent", "schedule_follow_up"], required: true },
  arguments: { type: Schema.Types.Mixed, required: true },
  status: { type: String, enum: ["pending", "approved", "declined", "failed"], default: "pending" },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });

export type AssistantPendingAction = InferSchemaType<typeof assistantPendingActionSchema>;
export const AssistantPendingActionModel = model<AssistantPendingAction>("AssistantPendingAction", assistantPendingActionSchema);
