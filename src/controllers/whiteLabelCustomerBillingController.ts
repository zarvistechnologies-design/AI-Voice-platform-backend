import { createHmac, timingSafeEqual } from "node:crypto";
import type { Response } from "express";

import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { OrganizationModel } from "../models/Organization.js";
import { UserModel } from "../models/User.js";
import { WhiteLabelBrandModel } from "../models/WhiteLabelBrand.js";
import { WhiteLabelCustomerInvoiceModel } from "../models/WhiteLabelCustomerInvoice.js";
import { razorpayConfigured, razorpayRequest } from "../services/razorpayService.js";
import {
  razorpayOrderForWhiteLabelCustomer,
  settleWhiteLabelCustomerOrder,
  whiteLabelCustomerBillingSummary,
  type WhiteLabelCustomerRazorpayOrder,
  type WhiteLabelCustomerRazorpayPayment,
} from "../services/whiteLabelCustomerBillingService.js";
import { HttpError } from "../utils/httpError.js";

function activeWhiteLabelOrgId(request: AuthenticatedRequest) {
  if (!request.organization?.whiteLabelAccountId) {
    throw new HttpError(403, "This organization is not a white-label customer.");
  }
  return request.organization.id;
}

function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string) {
  const expected = createHmac("sha256", env.razorpayKeySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  const valid = signature.length === expected.length
    && timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"));
  if (!valid) throw new HttpError(400, "Invalid Razorpay payment signature.");
}

export async function getWhiteLabelCustomerBilling(request: AuthenticatedRequest, response: Response) {
  const result = await whiteLabelCustomerBillingSummary(activeWhiteLabelOrgId(request));
  response.json({
    billingModel: "white_label_customer_checkout",
    paymentReadiness: {
      ready: razorpayConfigured() && Boolean(env.razorpayWebhookSecret),
      provider: "razorpay",
      reason: razorpayConfigured() && env.razorpayWebhookSecret
        ? ""
        : "Razorpay API credentials and webhook signing must be configured.",
    },
    currentInvoice: result.invoice,
    invoices: result.invoices,
  });
}

export async function createWhiteLabelCustomerCheckout(request: AuthenticatedRequest, response: Response) {
  if (!razorpayConfigured() || !env.razorpayWebhookSecret) {
    throw new HttpError(503, "Razorpay API credentials and webhook signing are not configured.");
  }
  const orgId = activeWhiteLabelOrgId(request);
  const { account, invoice, order } = await razorpayOrderForWhiteLabelCustomer(orgId);
  if (!order) {
    response.json({ settled: true, invoice });
    return;
  }
  const brand = await WhiteLabelBrandModel.findById(invoice.brandId).select("branding.productName").lean();
  response.status(201).json({
    settled: false,
    provider: "razorpay",
    kind: "order",
    keyId: env.razorpayKeyId,
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
  const orderId = String(request.body.razorpay_order_id ?? "");
  const paymentId = String(request.body.razorpay_payment_id ?? "");
  const signature = String(request.body.razorpay_signature ?? "");
  if (!orderId || !paymentId || !signature) throw new HttpError(400, "Incomplete Razorpay payment response.");
  verifyCheckoutSignature(orderId, paymentId, signature);
  const [order, payment] = await Promise.all([
    razorpayRequest<WhiteLabelCustomerRazorpayOrder>(`/orders/${encodeURIComponent(orderId)}`),
    razorpayRequest<WhiteLabelCustomerRazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`),
  ]);
  if (order.notes?.orgId !== orgId) throw new HttpError(403, "This Razorpay order belongs to another organization.");
  const invoice = await settleWhiteLabelCustomerOrder(order, payment);
  response.json({ success: true, invoice });
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

export async function downloadWhiteLabelCustomerInvoice(request: AuthenticatedRequest, response: Response) {
  const orgId = activeWhiteLabelOrgId(request);
  const invoice = await WhiteLabelCustomerInvoiceModel.findOne({ _id: request.params.invoiceId, orgId });
  if (!invoice) throw new HttpError(404, "Invoice not found.");
  const [organization, brand] = await Promise.all([
    OrganizationModel.findById(orgId).select("name ownerUserId").lean(),
    WhiteLabelBrandModel.findById(invoice.brandId).select("branding legal support").lean(),
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
  response.send(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(invoice.invoiceNumber)}</title><style>body{font:15px Arial;color:#172033;margin:48px}.wrap{max-width:760px;margin:auto}.top{display:flex;justify-content:space-between;border-bottom:3px solid ${escapeHtml(brand?.branding?.primaryColor || "#10b981")};padding-bottom:24px}h1{margin:0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:32px}.row{display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid #e5e7eb}.total{font-size:22px;font-weight:700;text-align:right;margin-top:24px}.muted{color:#64748b}@media(max-width:600px){body{margin:20px}.grid{grid-template-columns:1fr}}@media print{button{display:none}}</style></head><body><div class="wrap"><div class="top"><div><h1>${escapeHtml(productName)}</h1><p>Subscription invoice</p></div><div><strong>${escapeHtml(invoice.invoiceNumber)}</strong><p>${escapeHtml(invoice.status.toUpperCase())}</p></div></div><div class="grid"><div><strong>Billed to</strong><p>${escapeHtml(organization?.name || owner?.name || "Customer")}<br>${escapeHtml(owner?.email || "")}</p></div><div><strong>Service period</strong><p>${escapeHtml(invoice.periodStart.toISOString().slice(0, 10))} to ${escapeHtml(invoice.periodEnd.toISOString().slice(0, 10))}<br>Payment: ${escapeHtml(invoice.razorpayPaymentId || "Pending")}</p></div></div><div class="row"><span>Recurring service</span><strong>${escapeHtml(money(invoice.recurringAmountMinor))}</strong></div>${invoice.setupFeeMinor ? `<div class="row"><span>Setup fee</span><strong>${escapeHtml(money(invoice.setupFeeMinor))}</strong></div>` : ""}${invoice.taxMinor ? `<div class="row"><span>${escapeHtml(invoice.taxLabel)} (${escapeHtml((invoice.taxRateBps / 100).toFixed(2))}%)</span><strong>${escapeHtml(money(invoice.taxMinor))}</strong></div>` : ""}${refundLine}<div class="total">${invoice.refundedMinor ? "Net payment" : "Total"}: ${escapeHtml(money(netPayment))}</div>${disputeLine}<p class="muted" style="margin-top:40px">Issued by ${escapeHtml(legalName)}${invoice.taxRegistrationId ? ` · Registration: ${escapeHtml(invoice.taxRegistrationId)}` : ""}. ${escapeHtml(brand?.support?.email || "")}</p><button onclick="print()">Print / Save PDF</button></div></body></html>`);
}
