import { Types } from "mongoose";

import { AssistantConversationModel } from "../models/AssistantConversation.js";
import { HttpError } from "../utils/httpError.js";
import type { AssistantMessage, AssistantReply } from "./assistantService.js";

function scope(ownerId: string, userId: string) {
  return { ownerId, userId };
}

export async function listAssistantConversations(ownerId: string, userId: string, page: number) {
  const rows = await AssistantConversationModel.find(scope(ownerId, userId))
    .sort({ updatedAt: -1, _id: -1 }).skip(page * 40).limit(41)
    .select("title updatedAt").lean();
  return {
    conversations: rows.slice(0, 40).map((row) => ({
      id: String(row._id), title: row.title, updatedAt: row.updatedAt,
    })),
    hasMore: rows.length > 40,
  };
}

export async function getAssistantConversation(ownerId: string, userId: string, id: string) {
  if (!Types.ObjectId.isValid(id)) throw new HttpError(404, "That chat was not found.");
  const conversation = await AssistantConversationModel.findOne({ _id: id, ...scope(ownerId, userId) }).lean();
  if (!conversation) throw new HttpError(404, "That chat was not found.");
  return {
    id: String(conversation._id), title: conversation.title, updatedAt: conversation.updatedAt,
    messages: conversation.messages.map((message) => ({
      role: message.role, content: message.content,
      ...(message.pendingAction?.id ? { pendingAction: message.pendingAction } : {}),
    })),
  };
}

export async function deleteAssistantConversation(ownerId: string, userId: string, id: string) {
  if (!Types.ObjectId.isValid(id)) throw new HttpError(404, "That chat was not found.");
  const result = await AssistantConversationModel.deleteOne({ _id: id, ...scope(ownerId, userId) });
  if (!result.deletedCount) throw new HttpError(404, "That chat was not found.");
}

export async function saveAssistantReply(
  ownerId: string, userId: string, id: string | undefined, history: AssistantMessage[], reply: AssistantReply,
) {
  const assistant = { role: "assistant" as const, content: reply.answer, pendingAction: reply.pendingAction };
  if (!id) {
    const firstPrompt = history.find((message) => message.role === "user")?.content ?? "New chat";
    const title = firstPrompt.replace(/\s+/g, " ").trim().slice(0, 80) || "New chat";
    const created = await AssistantConversationModel.create({
      ...scope(ownerId, userId), title, messages: [...history, assistant],
    });
    return String(created._id);
  }
  if (!Types.ObjectId.isValid(id)) throw new HttpError(404, "That chat was not found.");
  const lastUserMessage = history.at(-1);
  if (!lastUserMessage || lastUserMessage.role !== "user") throw new HttpError(400, "The latest message must be yours.");
  const updated = await AssistantConversationModel.updateOne(
    { _id: id, ...scope(ownerId, userId) },
    { $push: { messages: { $each: [lastUserMessage, assistant] } }, $currentDate: { updatedAt: true } },
  );
  if (!updated.matchedCount) throw new HttpError(404, "That chat was not found.");
  return id;
}

export async function recordAssistantActionDecision(
  ownerId: string, userId: string, actionId: string, answer: string,
) {
  const conversation = await AssistantConversationModel.findOne({
    ...scope(ownerId, userId), "messages.pendingAction.id": actionId,
  });
  if (!conversation) return;
  const message = conversation.messages.find((item) => item.pendingAction?.id === actionId);
  if (!message) return;
  message.content = answer;
  message.pendingAction = undefined;
  await conversation.save();
}
