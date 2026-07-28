import { Router } from "express";

import {
  exportCallsCsv,
  getExternalCall,
  listExternalCalls,
  streamCallEvents,
  streamCallRecordingFile,
  streamSharedCallRecordingFile,
} from "../controllers/callController.js";
import {
  createOutboundCall,
  listAgents,
} from "../controllers/voiceController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireApiScope, requireAuth, requireRole } from "../middleware/auth.js";

export const externalApiRouter = Router();

externalApiRouter.get("/calls/:callId/recording/play", asyncHandler(streamSharedCallRecordingFile));
externalApiRouter.use(requireAuth);
externalApiRouter.get("/agents", requireApiScope("read"), asyncHandler(listAgents));
externalApiRouter.get("/calls", requireApiScope("read"), asyncHandler(listExternalCalls));
externalApiRouter.get("/call-logs", requireApiScope("read"), asyncHandler(listExternalCalls));
externalApiRouter.get("/calls/stream", requireApiScope("read"), asyncHandler(streamCallEvents));
externalApiRouter.get("/calls/export.csv", requireApiScope("read"), asyncHandler(exportCallsCsv));
externalApiRouter.post(
  "/calls/outbound",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  asyncHandler(createOutboundCall),
);
externalApiRouter.post(
  "/outbound-calls",
  requireApiScope("calls:trigger"),
  requireRole("owner", "admin", "member"),
  asyncHandler(createOutboundCall),
);
externalApiRouter.get("/calls/:callId/recording", requireApiScope("read"), asyncHandler(streamCallRecordingFile));
externalApiRouter.get("/calls/:callId/recording-file", requireApiScope("read"), asyncHandler(streamCallRecordingFile));
externalApiRouter.get("/calls/:callId", requireApiScope("read"), asyncHandler(getExternalCall));
externalApiRouter.get("/call-logs/:callId", requireApiScope("read"), asyncHandler(getExternalCall));
