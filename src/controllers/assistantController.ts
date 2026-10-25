import type { Response } from "express";
import { z } from "zod";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { HttpError } from "../utils/httpError.js";
import { askVozonAssistant } from "../services/assistantService.js";

export const chatSchema = z.object({
  messages: z.array(z.discriminatedUnion("role", [
    z.object({ role: z.literal("user"), content: z.string().trim().min(1).max(2_000) }),
    // Model replies can be longer than the user's input limit. Rejecting one here
    // made the next turn fail with a 400 after an otherwise successful answer.
    z.object({ role: z.literal("assistant"), content: z.string().trim().min(1).max(8_000) }),
  ])).min(1).max(20),
}).strict();

export async function chatWithAssistant(request: AuthenticatedRequest, response: Response) {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) throw new HttpError(400, "Messages must be non-empty. User messages can be up to 2,000 characters.");
  if (parsed.data.messages.at(-1)?.role !== "user") {
    throw new HttpError(400, "The latest assistant message must be from you.");
  }
  const history = parsed.data.messages.slice(-12);
  const answer = await askVozonAssistant(request.organization.id, history);
  response.json({ answer });
}
