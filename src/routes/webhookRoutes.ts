import express, { Router } from "express";

import { receiveLivekitWebhook } from "../controllers/livekitWebhookController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { receiveStripeWebhook } from "../controllers/billingController.js";

export const webhookRouter = Router();

webhookRouter.post(
  "/livekit",
  express.raw({ type: ["application/webhook+json", "application/json"] }),
  asyncHandler(receiveLivekitWebhook),
);
webhookRouter.post(
  "/stripe",
  express.raw({ type: "application/json" }),
  asyncHandler(receiveStripeWebhook),
);
