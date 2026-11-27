import { createHmac, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import { isValidObjectId } from "mongoose";

import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { OrganizationModel } from "../models/Organization.js";
import { UserModel } from "../models/User.js";
import { WhiteLabelBrandModel } from "../models/WhiteLabelBrand.js";
import { WhiteLabelCustomerInvoiceModel } from "../models/WhiteLabelCustomerInvoice.js";
import { WhiteLabelSubscriptionModel } from "../models/WhiteLabelSubscription.js";
import { WhiteLabelRechargeOrderModel } from "../models/WhiteLabelRechargeOrder.js";
import { WhiteLabelAccountModel } from "../models/WhiteLabelAccount.js";
import { razorpayConfigured, razorpayRequest } from "../services/razorpayService.js";
import {
  effectiveCustomerBillingMode,
  razorpayOrderForWhiteLabelCustomer,
  resolveCredentialsForCustomerOrg,
  settleWhiteLabelCustomerOrder,
  whiteLabelCustomerBillingSummary,
  type WhiteLabelCustomerRazorpayOrder,
  type WhiteLabelCustomerRazorpayPayment,
} from "../services/whiteLabelCustomerBillingService.js";
import { HttpError } from "../utils/httpError.js";
import { createWhiteLabelRecharge, verifyWhiteLabelRecharge } from "../services/whiteLabelRechargeService.js";

async function assertCustomerRetailMode(orgId: string) {
  const subscription = await WhiteLabelSubscriptionModel.findOne({ orgId })
    .select("accountId billingMode")
    .lean();
  const account = subscription
    ? await WhiteLabelAccountModel.findById(subscription.accountId)
      .select("retailBilling.enabled retailBilling.gatewayMode rechargePackages.active")
      .lean()
    : null;
  if (!subscription || !account || effectiveCustomerBillingMode(account, subscription) !== "retail") {
    throw new HttpError(409, "Retail invoice checkout is not enabled for this workspace.");
  }
}

function activeWhiteLabelOrgId(request: AuthenticatedRequest) {
  if (!request.organization?.whiteLabelAccountId) {
    throw new HttpError(403, "This organization is not a white-label customer.");
  }
  return request.organization.id;
}

function verifyCheckoutSignatureWithSecret(orderId: string, paymentId: string, signature: string, secret: string) {
  const expected = createHmac("sha256", secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  const valid = signature.length === expected.length
    && timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"));
  if (!valid) throw new HttpError(400, "Invalid Razorpay payment signature.");
}

export async function getWhiteLabelCustomerBilling(request: AuthenticatedRequest, response: Response) {
  const orgId = activeWhiteLabelOrgId(request);
  await assertCustomerRetailMode(orgId);
  const credentials = await resolveCredentialsForCustomerOrg(orgId);
  const result = await whiteLabelCustomerBillingSummary(orgId);
  response.json({
    billingModel: "white_label_customer_checkout",
    paymentReadiness: {
      ready: Boolean(credentials.keyId && credentials.keySecret),
      provider: "razorpay",
      mode: credentials.isCustom ? "custom_partner" : "platform",
      reason: credentials.keyId && credentials.keySecret
        ? ""
        : "Razorpay credentials are not configured.",
    },
    currentInvoice: result.invoice,
    invoices: result.invoices,
  });
}

export async function createWhiteLabelCustomerCheckout(request: AuthenticatedRequest, response: Response) {
  const orgId = activeWhiteLabelOrgId(request);
  const { account, invoice, order, credentials } = await razorpayOrderForWhiteLabelCustomer(orgId);
  if (!order) {
    response.json({ settled: true, invoice });
    return;
  }
  const brand = await WhiteLabelBrandModel.findById(invoice.brandId).select("branding.productName").lean();
  response.status(201).json({
    settled: false,
    provider: "razorpay",
    kind: "order",
    keyId: credentials.keyId,
    orderId: order.id,
    amount: order.amount,
    currency: invoice.currency,
    name: brand?.branding?.productName ?? account.name,
    description: `Invoice ${invoice.invoiceNumber}`,
    prefill: { name: request.user?.name ?? "", email: request.user?.email ?? "" },
    displayMode: "all",
    invoice,
  });
}

export async function verifyWhiteLabelCustomerCheckout(request: AuthenticatedRequest, response: Response) {
  const orgId = activeWhiteLabelOrgId(request);
  await assertCustomerRetailMode(orgId);
  const orderId = String(request.body.razorpay_order_id ?? "");
  const paymentId = String(request.body.razorpay_payment_id ?? "");
  const signature = String(request.body.razorpay_signature ?? "");
  if (!orderId || !paymentId || !signature) throw new HttpError(400, "Incomplete Razorpay payment response.");
  const credentials = await resolveCredentialsForCustomerOrg(orgId);
  verifyCheckoutSignatureWithSecret(orderId, paymentId, signature, credentials.keySecret);
  const [order, payment] = await Promise.all([
    razorpayRequest<WhiteLabelCustomerRazorpayOrder>(`/orders/${encodeURIComponent(orderId)}`, { credentials }),
    razorpayRequest<WhiteLabelCustomerRazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`, { credentials }),
  ]);
  if (order.notes?.orgId !== orgId) throw new HttpError(403, "This Razorpay order belongs to another organization.");
  const invoice = await settleWhiteLabelCustomerOrder(order, payment);
  response.json({ success: true, invoice });
}

export async function createWhiteLabelRechargeCheckout(request: AuthenticatedRequest, response: Response) {
  const orgId = activeWhiteLabelOrgId(request);
  const { recharge, order, credentials, account } = await createWhiteLabelRecharge(orgId, String(request.body.packageId ?? ""));
  const brand = request.organization?.whiteLabelBrandId
    ? await WhiteLabelBrandModel.findById(request.organization.whiteLabelBrandId).select("branding.productName").lean()
    : null;
  response.status(201).json({
    provider: "razorpay", kind: "order", keyId: credentials.keyId,
    orderId: order.id, amount: order.amount, currency: recharge.currency,
    credits: recharge.credits, name: brand?.branding?.productName ?? account.name,
    description: `${recharge.packageName}: ${recharge.credits} credits`,
    prefill: { name: request.user?.name ?? "", email: request.user?.email ?? "" },
    displayMode: "all",
  });
}

export async function verifyWhiteLabelRechargeCheckout(request: AuthenticatedRequest, response: Response) {
  const orgId = activeWhiteLabelOrgId(request);
  const orderId = String(request.body.razorpay_order_id ?? "");
  const paymentId = String(request.body.razorpay_payment_id ?? "");
  const signature = String(request.body.razorpay_signature ?? "");
  if (!orderId || !paymentId || !signature) throw new HttpError(400, "Incomplete Razorpay payment response.");
  const recharge = await verifyWhiteLabelRecharge(orgId, orderId, paymentId, signature);
  response.json({ success: true, credits: recharge.credits, rechargeId: recharge.id });
}

export async function downloadWhiteLabelRechargeInvoice(request: AuthenticatedRequest, response: Response) {
  const orgId = activeWhiteLabelOrgId(request);
  const rechargeId = String(request.params.rechargeId ?? "");
  if (!isValidObjectId(rechargeId)) throw new HttpError(400, "Invalid recharge receipt ID.");
  const recharge = await WhiteLabelRechargeOrderModel.findOne({ _id: rechargeId, orgId, status: "paid" });
  if (!recharge) throw new HttpError(404, "Paid recharge invoice not found.");
  const [account, organization] = await Promise.all([
    WhiteLabelAccountModel.findById(recharge.accountId).select("name retailBilling.taxLabel retailBilling.taxRegistrationId").lean(),
    OrganizationModel.findById(orgId).select("name whiteLabelBrandId").lean(),
  ]);
  const brand = organization?.whiteLabelBrandId
    ? await WhiteLabelBrandModel.findById(organization.whiteLabelBrandId).select("branding legal support").lean()
    : null;
  const productName = brand?.branding?.productName ?? account?.name ?? "Voice platform";
  const legalName = brand?.legal?.legalBusinessName || brand?.branding?.companyName || productName;
  const taxLabel = account?.retailBilling?.taxLabel || "Tax";
  const tax = recharge.taxRateBps > 0
    ? Math.round(recharge.amountMinor * recharge.taxRateBps / (10_000 + recharge.taxRateBps)) : 0;
  const amount = (minor: number) => new Intl.NumberFormat(recharge.currency === "INR" ? "en-IN" : "en-US", { style: "currency", currency: recharge.currency }).format(minor / 100);
  const number = `WLR-${recharge.id.slice(-12).toUpperCase()}`;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Disposition", `inline; filename="${number}.html"`);
  response.send(`<!doctype html><html><head><meta charset="utf-8"><title>${number}</title><style>body{font:15px Arial,sans-serif;color:#172033;max-width:720px;margin:48px auto;padding:0 20px}header{display:flex;justify-content:space-between;border-bottom:2px solid ${escapeHtml(brand?.branding?.primaryColor || "#1b695b")};padding-bottom:20px}h1{margin:0}.row{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid #ddd;padding:14px 0}.muted{color:#64748b}strong{overflow-wrap:anywhere}@media print{button{display:none}}</style></head><body><header><div><h1>${escapeHtml(productName)}</h1><p>Credit recharge invoice</p></div><strong>${number}</strong></header><p>Billed to: ${escapeHtml(organization?.name ?? "Customer")}<br>Paid: ${escapeHtml(recharge.paidAt?.toISOString() ?? "")}</p><div class="row"><span>${escapeHtml(recharge.packageName)} · ${recharge.credits} credits</span><strong>${escapeHtml(amount(recharge.amountMinor - tax))}</strong></div>${tax ? `<div class="row"><span>${escapeHtml(taxLabel)} included (${(recharge.taxRateBps / 100).toFixed(2)}%)</span><strong>${escapeHtml(amount(tax))}</strong></div>` : ""}<div class="row"><strong>Total paid</strong><strong>${escapeHtml(amount(recharge.amountMinor))}</strong></div><p class="muted">Issued by ${escapeHtml(legalName)}${account?.retailBilling?.taxRegistrationId ? ` · Registration: ${escapeHtml(account.retailBilling.taxRegistrationId)}` : ""} · Razorpay payment: ${escapeHtml(recharge.razorpayPaymentId)}</p><button onclick="print()">Print / Save PDF</button></body></html>`);
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

export async function downloadWhiteLabelCustomerInvoice(request: AuthenticatedRequest, response: Response) {
  const orgId = activeWhiteLabelOrgId(request);
  const invoiceId = String(request.params.invoiceId ?? "");
  if (!isValidObjectId(invoiceId)) throw new HttpError(400, "Invalid customer invoice ID.");
  const invoice = await WhiteLabelCustomerInvoiceModel.findOne({ _id: invoiceId, orgId });
  if (!invoice) throw new HttpError(404, "Invoice not found.");
  const [organization, brand, subscription] = await Promise.all([
    OrganizationModel.findById(orgId).select("name ownerUserId").lean(),
    WhiteLabelBrandModel.findById(invoice.brandId).select("branding legal support").lean(),
    WhiteLabelSubscriptionModel.findById(invoice.subscriptionId).select("priceSnapshot").lean(),
  ]);
  const owner = organization ? await UserModel.findById(organization.ownerUserId).select("name email").lean() : null;
  const productName = brand?.branding?.productName ?? "Voice platform";
  const legalName = brand?.legal?.legalBusinessName || brand?.branding?.companyName || productName;
  const money = (minor: number) => new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: invoice.currency,
  }).format(minor / 100);
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Disposition", `inline; filename="${escapeHtml(invoice.invoiceNumber)}.html"`);
  const refundLine = invoice.refundedMinor
    ? `<div class="row"><span>Refunded</span><strong>-${escapeHtml(money(invoice.refundedMinor))}</strong></div>`
    : "";
  const disputeLine = invoice.disputeStatus !== "none"
    ? `<p class="muted">Dispute status: ${escapeHtml(invoice.disputeStatus.replaceAll("_", " "))}</p>`
    : "";
  const netPayment = Math.max(0, invoice.totalMinor - invoice.refundedMinor);
  const isPermanent = (subscription?.priceSnapshot as Record<string, unknown> | undefined)?.billingType === "permanent";
  const servicePeriod = isPermanent
    ? "Permanent access"
    : `${escapeHtml(invoice.periodStart.toISOString().slice(0, 10))} to ${escapeHtml(invoice.periodEnd.toISOString().slice(0, 10))}`;
  response.send(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(invoice.invoiceNumber)}</title><style>body{font:15px Arial;color:#172033;margin:48px}.wrap{max-width:760px;margin:auto}.top{display:flex;justify-content:space-between;border-bottom:3px solid ${escapeHtml(brand?.branding?.primaryColor || "#10b981")};padding-bottom:24px}h1{margin:0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:32px}.row{display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid #e5e7eb}.total{font-size:22px;font-weight:700;text-align:right;margin-top:24px}.muted{color:#64748b}@media(max-width:600px){body{margin:20px}.grid{grid-template-columns:1fr}}@media print{button{display:none}}</style></head><body><div class="wrap"><div class="top"><div><h1>${escapeHtml(productName)}</h1><p>${isPermanent ? "One-time package invoice" : "Subscription invoice"}</p></div><div><strong>${escapeHtml(invoice.invoiceNumber)}</strong><p>${escapeHtml(invoice.status.toUpperCase())}</p></div></div><div class="grid"><div><strong>Billed to</strong><p>${escapeHtml(organization?.name || owner?.name || "Customer")}<br>${escapeHtml(owner?.email || "")}</p></div><div><strong>Service period</strong><p>${servicePeriod}<br>Payment: ${escapeHtml(invoice.razorpayPaymentId || "Pending")}</p></div></div><div class="row"><span>${isPermanent ? "One-time package" : "Recurring service"}</span><strong>${escapeHtml(money(invoice.recurringAmountMinor))}</strong></div>${invoice.setupFeeMinor ? `<div class="row"><span>Setup fee</span><strong>${escapeHtml(money(invoice.setupFeeMinor))}</strong></div>` : ""}${invoice.taxMinor ? `<div class="row"><span>${escapeHtml(invoice.taxLabel)} (${escapeHtml((invoice.taxRateBps / 100).toFixed(2))}%)</span><strong>${escapeHtml(money(invoice.taxMinor))}</strong></div>` : ""}${refundLine}<div class="total">${invoice.refundedMinor ? "Net payment" : "Total"}: ${escapeHtml(money(netPayment))}</div>${disputeLine}<p class="muted" style="margin-top:40px">Issued by ${escapeHtml(legalName)}${invoice.taxRegistrationId ? ` · Registration: ${escapeHtml(invoice.taxRegistrationId)}` : ""}. ${escapeHtml(brand?.support?.email || "")}</p><button onclick="print()">Print / Save PDF</button></div></body></html>`);
}
