import { Router } from "express";

import {
  createApiKey,
  createWebhook,
  deleteWebhook,
  listApiKeys,
  listWebhooks,
  revokeApiKey,
  testWebhook,
  updateWebhook,
} from "../controllers/developerController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  requireWhiteLabelFeature,
  requireWhiteLabelResourceCapacity,
  requireWhiteLabelSubscription,
  requireWhiteLabelWriteAccess,
} from "../middleware/whiteLabelEntitlements.js";

export const developerRouter = Router();

developerRouter.use(requireAuth, requireRole("owner", "admin"));
developerRouter.use(requireWhiteLabelSubscription, requireWhiteLabelFeature("developerApi"));
developerRouter.get("/webhooks", asyncHandler(listWebhooks));
developerRouter.post("/webhooks", requireWhiteLabelWriteAccess, asyncHandler(createWebhook));
developerRouter.patch("/webhooks/:webhookId", requireWhiteLabelWriteAccess, asyncHandler(updateWebhook));
developerRouter.delete("/webhooks/:webhookId", requireWhiteLabelWriteAccess, asyncHandler(deleteWebhook));
developerRouter.post("/webhooks/:webhookId/test", requireWhiteLabelWriteAccess, asyncHandler(testWebhook));
developerRouter.get("/api-keys", asyncHandler(listApiKeys));
developerRouter.post("/api-keys", requireWhiteLabelWriteAccess, requireWhiteLabelResourceCapacity("apiKeys"), asyncHandler(createApiKey));
developerRouter.delete("/api-keys/:apiKeyId", requireWhiteLabelWriteAccess, asyncHandler(revokeApiKey));
