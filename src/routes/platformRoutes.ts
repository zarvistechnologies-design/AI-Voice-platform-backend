import { Router } from "express";
import type { Response } from "express";
import { isValidObjectId } from "mongoose";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { OrganizationModel } from "../models/Organization.js";
import { UserModel } from "../models/User.js";
import { BillingInvoiceModel } from "../models/BillingInvoice.js";
import { BillingTransactionModel } from "../models/BillingTransaction.js";
import { CreditWalletModel } from "../models/CreditWallet.js";
import { renderBillingInvoiceForOrganization } from "../controllers/razorpayBillingController.js";
import { HttpError } from "../utils/httpError.js";

import {
  createWhiteLabelAccount,
  getWhiteLabelAccount,
  listEligibleWhiteLabelOrganizations,
  listPlatformAuditLogs,
  listWhiteLabelAccounts,
  updateWhiteLabelAccountCommercials,
  updateWhiteLabelAccountStatus,
} from "../controllers/platformWhiteLabelController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requirePlatformRole } from "../middleware/auth.js";
import { requireWhiteLabelEnabled } from "../middleware/whiteLabelEnabled.js";

export const platformRouter = Router();

platformRouter.use(requireAuth, requirePlatformRole("super_admin"));
platformRouter.get("/billing/accounts", asyncHandler(async (request: AuthenticatedRequest, response: Response) => {
  const page = Math.max(1, Math.min(10000, Number(request.query.page) || 1));
  const limit = 30;
  const query = String(request.query.q ?? "").trim().slice(0, 100);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ownerIds = query ? await UserModel.find({ email: { $regex: escaped, $options: "i" } }).select("_id").limit(100).lean() : [];
  const filter = query ? { whiteLabelAccountId: { $exists: false }, $or: [
    { name: { $regex: escaped, $options: "i" } },
    { slug: { $regex: escaped, $options: "i" } },
    { ownerUserId: { $in: ownerIds.map((owner) => owner._id) } },
  ] } : { whiteLabelAccountId: { $exists: false } };
  const [organizations, total] = await Promise.all([
    OrganizationModel.find(filter).select("name slug ownerUserId billingProfile referralCode createdAt whiteLabelAccountId").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    OrganizationModel.countDocuments(filter),
  ]);
  const ids = organizations.map((org) => String(org._id));
  const [owners, invoiceSummaries, wallets] = await Promise.all([
    UserModel.find({ _id: { $in: organizations.map((org) => org.ownerUserId) } }).select("name email").lean(),
    BillingInvoiceModel.aggregate([{ $match: { orgId: { $in: organizations.map((org) => org._id) } } }, { $sort: { createdAt: -1 } }, { $group: { _id: "$orgId", invoiceCount: { $sum: 1 }, lastInvoice: { $first: "$$ROOT" } } }]),
    CreditWalletModel.find({ orgId: { $in: ids } }).select("orgId balanceCredits currency lastPaymentAt lastPaymentStatus").lean(),
  ]);
  const ownerMap = new Map(owners.map((owner) => [String(owner._id), owner]));
  const walletMap = new Map(wallets.map((wallet) => [wallet.orgId, wallet]));
  const invoiceMap = new Map(invoiceSummaries.map((summary) => [String(summary._id), summary]));
  response.json({ page, total, limit, accounts: organizations.map((org) => {
    const invoiceSummary = invoiceMap.get(String(org._id));
    return { ...org, owner: ownerMap.get(String(org.ownerUserId)) ?? null, wallet: walletMap.get(String(org._id)) ?? null,
      invoiceCount: invoiceSummary?.invoiceCount ?? 0,
      lastInvoice: invoiceSummary?.lastInvoice ?? null };
  }) });
}));
platformRouter.get("/billing/accounts/:orgId", asyncHandler(async (request: AuthenticatedRequest, response: Response) => {
  if (!isValidObjectId(request.params.orgId)) throw new HttpError(400, "Invalid account ID.");
  const organization = await OrganizationModel.findById(request.params.orgId).select("name slug ownerUserId billingProfile referralCode createdAt whiteLabelAccountId").lean();
  if (!organization) throw new HttpError(404, "Account not found.");
  const [owner, wallet, invoices, transactions] = await Promise.all([
    UserModel.findById(organization.ownerUserId).select("name email").lean(),
    CreditWalletModel.findOne({ orgId: request.params.orgId }).lean(),
    BillingInvoiceModel.find({ orgId: request.params.orgId }).sort({ createdAt: -1 }).limit(100).lean(),
    BillingTransactionModel.find({ orgId: request.params.orgId, category: { $in: ["payment", "auto_reload"] } }).sort({ createdAt: -1 }).limit(100).lean(),
  ]);
  response.json({ organization, owner, wallet, invoices, transactions });
}));
platformRouter.get("/billing/accounts/:orgId/invoices/:invoiceId", asyncHandler(async (request: AuthenticatedRequest, response: Response) => {
  if (!isValidObjectId(request.params.orgId) || !isValidObjectId(request.params.invoiceId)) throw new HttpError(400, "Invalid invoice ID.");
  await renderBillingInvoiceForOrganization(request.params.invoiceId, request.params.orgId, response);
}));
platformRouter.use(requireWhiteLabelEnabled);
platformRouter.get("/white-label/accounts", asyncHandler(listWhiteLabelAccounts));
platformRouter.get("/white-label/eligible-organizations", asyncHandler(listEligibleWhiteLabelOrganizations));
platformRouter.post("/white-label/accounts", asyncHandler(createWhiteLabelAccount));
platformRouter.get("/white-label/accounts/:accountId", asyncHandler(getWhiteLabelAccount));
platformRouter.patch("/white-label/accounts/:accountId/status", asyncHandler(updateWhiteLabelAccountStatus));
platformRouter.patch("/white-label/accounts/:accountId/commercials", asyncHandler(updateWhiteLabelAccountCommercials));
platformRouter.get("/audit-log", asyncHandler(listPlatformAuditLogs));
