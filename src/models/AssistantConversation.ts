import { Schema, model, type InferSchemaType } from "mongoose";

const assistantConversationMessageSchema = new Schema({
  role: { type: String, enum: ["user", "assistant"], required: true },
  content: { type: String, required: true },
  pendingAction: {
    id: String,
    title: String,
    description: String,
    fields: [{ label: String, value: String }],
    expiresAt: String,
  },
}, { _id: false });

const assistantConversationSchema = new Schema({
  ownerId: { type: String, required: true },
  userId: { type: String, required: true },
  title: { type: String, required: true, maxlength: 120 },
  messages: { type: [assistantConversationMessageSchema], default: [] },
}, { timestamps: true });

assistantConversationSchema.index({ ownerId: 1, userId: 1, updatedAt: -1 });

export type AssistantConversation = InferSchemaType<typeof assistantConversationSchema>;
export const AssistantConversationModel = model<AssistantConversation>("AssistantConversation", assistantConversationSchema);
