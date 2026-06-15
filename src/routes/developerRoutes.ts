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

export const developerRouter = Router();

developerRouter.use(requireAuth, requireRole("owner", "admin"));
developerRouter.get("/webhooks", asyncHandler(listWebhooks));
developerRouter.post("/webhooks", asyncHandler(createWebhook));
developerRouter.patch("/webhooks/:webhookId", asyncHandler(updateWebhook));
developerRouter.delete("/webhooks/:webhookId", asyncHandler(deleteWebhook));
developerRouter.post("/webhooks/:webhookId/test", asyncHandler(testWebhook));
developerRouter.get("/api-keys", asyncHandler(listApiKeys));
developerRouter.post("/api-keys", asyncHandler(createApiKey));
developerRouter.delete("/api-keys/:apiKeyId", asyncHandler(revokeApiKey));
