import { Router } from "express";

import { chatWithAssistant } from "../controllers/assistantController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rateLimit.js";

export const assistantRouter = Router();
const assistantRateLimit = createRateLimit({
  windowMs: 60_000,
  max: 20,
  message: "Ask Vozon is receiving too many requests. Wait a minute and try again.",
});

assistantRouter.use(requireAuth);
assistantRouter.post("/chat", assistantRateLimit, asyncHandler(chatWithAssistant));
