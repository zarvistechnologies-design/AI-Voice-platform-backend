import type { Response } from "express";
import { z } from "zod";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { HttpError } from "../utils/httpError.js";
import { askVozonAssistant } from "../services/assistantService.js";
import { decideAssistantAction } from "../services/assistantActionService.js";
import {
  deleteAssistantConversation, getAssistantConversation, listAssistantConversations,
  recordAssistantActionDecision, saveAssistantReply,
} from "../services/assistantConversationService.js";
import type { WhiteLabelEntitledRequest } from "../middleware/whiteLabelEntitlements.js";

export const chatSchema = z.object({
  conversationId: z.string().regex(/^[0-9a-f]{24}$/i).optional(),
  messages: z.array(z.discriminatedUnion("role", [
    z.object({ role: z.literal("user"), content: z.string().trim().min(1).max(2_000) }),
    // Model replies can be longer than the user's input limit. Rejecting one here
    // made the next turn fail with a 400 after an otherwise successful answer.
    z.object({ role: z.literal("assistant"), content: z.string().trim().min(1).max(8_000) }),
  ])).min(1).max(20),
}).strict();

export async function chatWithAssistant(request: AuthenticatedRequest, response: Response) {
  if (!request.organization || !request.user || request.apiKey) throw new HttpError(401, "Sign in to use Ask Vozon.");
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) throw new HttpError(400, "Messages must be non-empty. User messages can be up to 2,000 characters.");
  if (parsed.data.messages.at(-1)?.role !== "user") {
    throw new HttpError(400, "The latest assistant message must be from you.");
  }
  const stored = parsed.data.conversationId
    ? await getAssistantConversation(request.organization.id, request.user.id, parsed.data.conversationId)
    : null;
  const history = stored
    ? [...stored.messages.map(({ role, content }) => ({ role, content })), parsed.data.messages.at(-1)!].slice(-12)
    : parsed.data.messages.slice(-12);
  const reply = await askVozonAssistant(request.organization.id, history, {
    userId: request.user.id, role: request.organization.role,
  });
  const conversationId = await saveAssistantReply(
    request.organization.id, request.user.id, parsed.data.conversationId, history, reply,
  );
  response.json({ ...reply, conversationId });
}

function signedInScope(request: AuthenticatedRequest) {
  if (!request.organization || !request.user || request.apiKey) throw new HttpError(401, "Sign in to view your chats.");
  return { ownerId: request.organization.id, userId: request.user.id };
}

export async function listAssistantChatHistory(request: AuthenticatedRequest, response: Response) {
  const { ownerId, userId } = signedInScope(request);
  const page = Number(request.query.page ?? 0);
  if (!Number.isInteger(page) || page < 0 || page > 1000) throw new HttpError(400, "Invalid history page.");
  response.json(await listAssistantConversations(ownerId, userId, page));
}

export async function getAssistantChatHistory(request: AuthenticatedRequest, response: Response) {
  const { ownerId, userId } = signedInScope(request);
  response.json(await getAssistantConversation(ownerId, userId, String(request.params.conversationId ?? "")));
}

export async function deleteAssistantChatHistory(request: AuthenticatedRequest, response: Response) {
  const { ownerId, userId } = signedInScope(request);
  await deleteAssistantConversation(ownerId, userId, String(request.params.conversationId ?? ""));
  response.status(204).end();
}

const decisionSchema = z.object({ approved: z.boolean() }).strict();

export async function reviewAssistantAction(request: AuthenticatedRequest, response: Response) {
  if (!request.organization || !request.user || request.apiKey) throw new HttpError(401, "Sign in to review this action.");
  const parsed = decisionSchema.safeParse(request.body);
  if (!parsed.success) throw new HttpError(400, "Choose whether to approve this action.");
  if (parsed.data.approved && !["owner", "admin"].includes(request.organization.role)) {
    throw new HttpError(403, "Only workspace owners and admins can approve agent changes or schedule follow-up calls.");
  }
  const rawLimit = (request as WhiteLabelEntitledRequest).whiteLabelSubscription?.limits.agents;
  const agentLimit = rawLimit === undefined ? undefined : Math.max(0, Number(rawLimit) || 0);
  const result = await decideAssistantAction(
    request.organization.id, request.user.id, String(request.params.actionId ?? ""), parsed.data.approved, agentLimit,
  );
  try {
    await recordAssistantActionDecision(request.organization.id, request.user.id, String(request.params.actionId ?? ""), result.answer);
  } catch (error) {
    console.error("[AskVozon] Action succeeded but chat history could not be updated:", error);
  }
  response.json(result);
}
