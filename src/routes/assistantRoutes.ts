import { Router } from "express";

import {
  chatWithAssistant, deleteAssistantChatHistory, getAssistantChatHistory,
  listAssistantChatHistory, reviewAssistantAction,
} from "../controllers/assistantController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rateLimit.js";
import { requireWhiteLabelSubscription, requireWhiteLabelWriteAccess } from "../middleware/whiteLabelEntitlements.js";

export const assistantRouter = Router();
const assistantRateLimit = createRateLimit({
  windowMs: 60_000,
  max: 20,
  message: "Ask Vozon is receiving too many requests. Wait a minute and try again.",
});

assistantRouter.use(requireAuth);
assistantRouter.use(requireWhiteLabelSubscription);
assistantRouter.post("/chat", assistantRateLimit, asyncHandler(chatWithAssistant));
assistantRouter.get("/chat/history", asyncHandler(listAssistantChatHistory));
assistantRouter.get("/chat/history/:conversationId", asyncHandler(getAssistantChatHistory));
assistantRouter.delete("/chat/history/:conversationId", asyncHandler(deleteAssistantChatHistory));
assistantRouter.post("/chat/actions/:actionId", assistantRateLimit, requireWhiteLabelWriteAccess, asyncHandler(reviewAssistantAction));
