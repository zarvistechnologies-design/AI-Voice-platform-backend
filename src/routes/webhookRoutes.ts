import express, { Router } from "express";

import { receiveLivekitWebhook } from "../controllers/livekitWebhookController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { receiveRazorpayWebhook } from "../controllers/razorpayBillingController.js";

export const webhookRouter = Router();

webhookRouter.post(
  "/livekit",
  // Room metadata can contain the full authoritative voice-agent runtime and
  // legitimately exceed body-parser's 100 KB default. Keep this scoped to the
  // signature-verified LiveKit endpoint instead of raising the global limit.
  express.raw({
    type: ["application/webhook+json", "application/json"],
    limit: "1mb",
  }),
  asyncHandler(receiveLivekitWebhook),
);
webhookRouter.post(
  "/razorpay",
  express.raw({ type: "application/json" }),
  asyncHandler(receiveRazorpayWebhook),
);

