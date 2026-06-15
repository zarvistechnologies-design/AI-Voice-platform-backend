import { Router } from "express";

import {
  acceptInvitation,
  createOrganizationWorkspace,
  inviteMember,
  listAuditLog,
  listMembers,
  listOrganizations,
  removeMember,
  switchOrganization,
  updateMember,
  updateCurrentOrganization,
} from "../controllers/organizationController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const organizationRouter = Router();

organizationRouter.use(requireAuth);
organizationRouter.get("/", asyncHandler(listOrganizations));
organizationRouter.post("/", asyncHandler(createOrganizationWorkspace));
organizationRouter.post("/invitations/accept", asyncHandler(acceptInvitation));
organizationRouter.post("/:orgId/switch", asyncHandler(switchOrganization));
organizationRouter.put(
  "/current",
  requireRole("owner", "admin"),
  asyncHandler(updateCurrentOrganization),
);
organizationRouter.get("/current/members", asyncHandler(listMembers));
organizationRouter.get("/current/audit-log", requireRole("owner", "admin"), asyncHandler(listAuditLog));
organizationRouter.post(
  "/current/invitations",
  requireRole("owner", "admin"),
  asyncHandler(inviteMember),
);
organizationRouter.patch(
  "/current/members/:memberId",
  requireRole("owner", "admin"),
  asyncHandler(updateMember),
);
organizationRouter.delete(
  "/current/members/:memberId",
  requireRole("owner", "admin"),
  asyncHandler(removeMember),
);
