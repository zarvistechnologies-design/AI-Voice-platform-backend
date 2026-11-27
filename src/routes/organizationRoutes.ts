import { Router } from "express";

import {
  acceptInvitation,
  completeInvitation,
  createOrganizationWorkspace,
  inviteMember,
  listAuditLog,
  listMembers,
  listOrganizations,
  previewInvitation,
  removeMember,
  switchOrganization,
  updateMember,
  updateCurrentOrganization,
  getCurrentOrganizationBrand,
  getCurrentWhiteLabelRevision,
} from "../controllers/organizationController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rateLimit.js";
import {
  requireWhiteLabelFeature,
  requireWhiteLabelSubscription,
  requireWhiteLabelWriteAccess,
} from "../middleware/whiteLabelEntitlements.js";

export const organizationRouter = Router();

const invitationPublicLimit = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many invitation attempts. Try again later.",
});

organizationRouter.get("/invitations/preview", invitationPublicLimit, asyncHandler(previewInvitation));
organizationRouter.post("/invitations/complete", invitationPublicLimit, asyncHandler(completeInvitation));

organizationRouter.use(requireAuth);
organizationRouter.get("/", asyncHandler(listOrganizations));
organizationRouter.get("/current/brand", asyncHandler(getCurrentOrganizationBrand));
organizationRouter.get("/current/white-label-revision", asyncHandler(getCurrentWhiteLabelRevision));
organizationRouter.post("/", asyncHandler(createOrganizationWorkspace));
organizationRouter.post("/invitations/accept", asyncHandler(acceptInvitation));
organizationRouter.post("/:orgId/switch", asyncHandler(switchOrganization));
organizationRouter.put(
  "/current",
  requireRole("owner", "admin"),
  requireWhiteLabelSubscription,
  requireWhiteLabelWriteAccess,
  asyncHandler(updateCurrentOrganization),
);
organizationRouter.get("/current/members", asyncHandler(listMembers));
organizationRouter.get("/current/audit-log", requireRole("owner", "admin"), asyncHandler(listAuditLog));
organizationRouter.post(
  "/current/invitations",
  requireRole("owner", "admin"),
  requireWhiteLabelSubscription,
  requireWhiteLabelFeature("teamAccess"),
  requireWhiteLabelWriteAccess,
  asyncHandler(inviteMember),
);
organizationRouter.patch(
  "/current/members/:memberId",
  requireRole("owner", "admin"),
  requireWhiteLabelSubscription,
  requireWhiteLabelFeature("teamAccess"),
  requireWhiteLabelWriteAccess,
  asyncHandler(updateMember),
);
organizationRouter.delete(
  "/current/members/:memberId",
  requireRole("owner", "admin"),
  requireWhiteLabelSubscription,
  requireWhiteLabelFeature("teamAccess"),
  requireWhiteLabelWriteAccess,
  asyncHandler(removeMember),
);
