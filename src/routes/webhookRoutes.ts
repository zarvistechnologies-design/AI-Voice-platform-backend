import express, { Router } from "express";

import { receiveLivekitWebhook } from "../controllers/livekitWebhookController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { receiveRazorpayWebhook } from "../controllers/razorpayBillingController.js";
import {
  receiveWhatsAppWebhook,
  verifyWhatsAppWebhook,
} from "../controllers/whatsappController.js";
import { handleWorkspaceRazorpayWebhook } from "../services/whatsappProductionService.js";

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

webhookRouter.post(
  "/razorpay/workspace/:ownerId",
  express.raw({ type: "application/json" }),
  asyncHandler(async (request, response) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
    const signature = String(request.header("x-razorpay-signature") ?? "");
    const result = await handleWorkspaceRazorpayWebhook(request.params.ownerId, rawBody, signature);
    response.status(200).json({ ok: true, ...result });
  }),
);

// Meta WhatsApp Webhook Verification handshake (GET)
webhookRouter.get("/whatsapp", verifyWhatsAppWebhook);

// Meta WhatsApp Webhook event ingestion (POST)
webhookRouter.post("/whatsapp", express.raw({ type: "application/json", limit: "1mb" }), asyncHandler(receiveWhatsAppWebhook));

