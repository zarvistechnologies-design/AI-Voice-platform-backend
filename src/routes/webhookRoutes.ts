import express, { Router } from "express";

import { receiveLivekitWebhook } from "../controllers/livekitWebhookController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { receiveRazorpayWebhook } from "../controllers/razorpayBillingController.js";

export const webhookRouter = Router();

webhookRouter.post(
  "/livekit",
  // Participant and room events can include the agent runtime metadata (for
  // example a long system prompt), so LiveKit payloads can legitimately
  // exceed body-parser's 100 KB default. Keep the larger limit scoped to this
  // signature-verified webhook instead of increasing it application-wide.
  express.raw({
    limit: "1mb",
    type: ["application/webhook+json", "application/json"],
  }),
  asyncHandler(receiveLivekitWebhook),
);
webhookRouter.post(
  "/razorpay",
  express.raw({ type: "application/json" }),
  asyncHandler(receiveRazorpayWebhook),
);

