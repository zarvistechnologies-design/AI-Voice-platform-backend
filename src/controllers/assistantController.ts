import type { Response } from "express";
import { z } from "zod";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { HttpError } from "../utils/httpError.js";
import { askVozonAssistant } from "../services/assistantService.js";
import { decideAssistantAction } from "../services/assistantActionService.js";
import type { WhiteLabelEntitledRequest } from "../middleware/whiteLabelEntitlements.js";

export const chatSchema = z.object({
  messages: z.array(z.discriminatedUnion("role", [
    z.object({ role: z.literal("user"), content: z.string().trim().min(1).max(2_000) }),
    // Model replies can be longer than the user's input limit. Rejecting one here
    // made the next turn fail with a 400 after an otherwise successful answer.
    z.object({ role: z.literal("assistant"), content: z.string().trim().min(1).max(8_000) }),
  ])).min(1).max(20),
}).strict();

export async function chatWithAssistant(request: AuthenticatedRequest, response: Response) {
  if (!request.organization || !request.user) throw new HttpError(401, "Authentication required.");
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) throw new HttpError(400, "Messages must be non-empty. User messages can be up to 2,000 characters.");
  if (parsed.data.messages.at(-1)?.role !== "user") {
    throw new HttpError(400, "The latest assistant message must be from you.");
  }
  const history = parsed.data.messages.slice(-12);
  response.json(await askVozonAssistant(request.organization.id, history, {
    userId: request.user.id, role: request.organization.role,
  }));
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
  response.json(await decideAssistantAction(
    request.organization.id, request.user.id, String(request.params.actionId ?? ""), parsed.data.approved, agentLimit,
  ));
}
