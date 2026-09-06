import { Router } from "express";
import multer from "multer";

import {
  addPartnerDomain,
  disablePartnerDomain,
  archivePartnerPlan,
  createPartnerBrand,
  createPartnerPlan,
  listPartnerCustomers,
  partnerWhiteLabelOverview,
  partnerWhiteLabelEconomics,
  provisionPartnerCustomer,
  publishPartnerBrand,
  publishPartnerPlan,
  revisePartnerPlan,
  updatePartnerBrand,
  uploadPartnerBrandAsset,
  updatePartnerCustomerStatus,
  updatePartnerCustomerSubscription,
  updatePartnerPlan,
  verifyPartnerDomain,
  verifyPartnerBrandEmailDomain,
} from "../controllers/partnerWhiteLabelController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireWhiteLabelEnabled } from "../middleware/whiteLabelEnabled.js";
import {
  createWhiteLabelPartnerCheckout,
  getWhiteLabelPartnerBilling,
  verifyWhiteLabelPartnerCheckout,
} from "../controllers/whiteLabelPartnerBillingController.js";

export const partnerRouter = Router();

const brandAssetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(_request, file, callback) {
    callback(null, new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp", "image/x-icon", "image/vnd.microsoft.icon"]).has(file.mimetype));
  },
});

partnerRouter.use(requireAuth, requireRole("owner", "admin"), requireWhiteLabelEnabled);
partnerRouter.get("/white-label", asyncHandler(partnerWhiteLabelOverview));
partnerRouter.get("/white-label/economics", asyncHandler(partnerWhiteLabelEconomics));
partnerRouter.get("/white-label/billing", asyncHandler(getWhiteLabelPartnerBilling));
partnerRouter.post("/white-label/billing/checkout", asyncHandler(createWhiteLabelPartnerCheckout));
partnerRouter.post("/white-label/billing/verify", asyncHandler(verifyWhiteLabelPartnerCheckout));
partnerRouter.post("/white-label/brands", asyncHandler(createPartnerBrand));
partnerRouter.patch("/white-label/brands/:brandId", asyncHandler(updatePartnerBrand));
partnerRouter.post("/white-label/brands/:brandId/assets", brandAssetUpload.single("file"), asyncHandler(uploadPartnerBrandAsset));
partnerRouter.post("/white-label/brands/:brandId/publish", asyncHandler(publishPartnerBrand));
partnerRouter.post("/white-label/brands/:brandId/verify-email-domain", asyncHandler(verifyPartnerBrandEmailDomain));
partnerRouter.post("/white-label/domains", asyncHandler(addPartnerDomain));
partnerRouter.post("/white-label/domains/:domainId/verify", asyncHandler(verifyPartnerDomain));
partnerRouter.patch("/white-label/domains/:domainId/status", asyncHandler(disablePartnerDomain));
partnerRouter.post("/white-label/plans", asyncHandler(createPartnerPlan));
partnerRouter.patch("/white-label/plans/:planId", asyncHandler(updatePartnerPlan));
partnerRouter.post("/white-label/plans/:planId/publish", asyncHandler(publishPartnerPlan));
partnerRouter.post("/white-label/plans/:planId/revise", asyncHandler(revisePartnerPlan));
partnerRouter.post("/white-label/plans/:planId/archive", asyncHandler(archivePartnerPlan));
partnerRouter.get("/white-label/customers", asyncHandler(listPartnerCustomers));
partnerRouter.post("/white-label/customers", asyncHandler(provisionPartnerCustomer));
partnerRouter.patch("/white-label/customers/:orgId/status", asyncHandler(updatePartnerCustomerStatus));
partnerRouter.patch("/white-label/customers/:orgId/subscription", asyncHandler(updatePartnerCustomerSubscription));
