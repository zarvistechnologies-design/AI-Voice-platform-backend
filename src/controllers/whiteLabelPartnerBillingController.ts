import { createHmac, timingSafeEqual } from "node:crypto";
import type { Response } from "express";

import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { razorpayConfigured, razorpayRequest } from "../services/razorpayService.js";
import { requirePartnerAccount } from "../services/whiteLabelService.js";
import {
  razorpayOrderForWhiteLabelInvoice,
  settleWhiteLabelPartnerOrder,
  whiteLabelPartnerBillingSummary,
  type WhiteLabelPartnerRazorpayOrder,
  type WhiteLabelPartnerRazorpayPayment,
} from "../services/whiteLabelPartnerBillingService.js";
import { HttpError } from "../utils/httpError.js";

function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string) {
  const expected = createHmac("sha256", env.razorpayKeySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  const valid = signature.length === expected.length
    && timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"));
  if (!valid) throw new HttpError(400, "Invalid Razorpay payment signature.");
}

export async function getWhiteLabelPartnerBilling(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const result = await whiteLabelPartnerBillingSummary(account.id);
  response.json({
    billingModel: "white_label_partner_to_platform",
    paymentReadiness: {
      ready: razorpayConfigured(),
      provider: "razorpay",
      reason: razorpayConfigured() ? "" : "Razorpay credentials are not configured.",
    },
    currentInvoice: result.invoice,
    invoices: result.invoices,
  });
}

export async function createWhiteLabelPartnerCheckout(request: AuthenticatedRequest, response: Response) {
  if (!razorpayConfigured()) throw new HttpError(503, "Razorpay credentials are not configured.");
  const account = await requirePartnerAccount(request);
  const summary = await whiteLabelPartnerBillingSummary(account.id);
  const invoiceId = String(request.body.invoiceId ?? summary.invoice.id);
  const { invoice, order } = await razorpayOrderForWhiteLabelInvoice(invoiceId, account.id);
  if (!order) {
    response.json({ settled: true, invoice });
    return;
  }
  response.status(201).json({
    settled: false,
    provider: "razorpay",
    kind: "order",
    keyId: env.razorpayKeyId,
    orderId: order.id,
    amount: order.amount,
    currency: invoice.currency,
    name: "Vozon white-label platform",
    description: `Partner invoice ${invoice.invoiceNumber}`,
    prefill: { name: request.user?.name ?? "", email: request.user?.email ?? "" },
    invoice,
  });
}

export async function verifyWhiteLabelPartnerCheckout(request: AuthenticatedRequest, response: Response) {
  const account = await requirePartnerAccount(request);
  const orderId = String(request.body.razorpay_order_id ?? "");
  const paymentId = String(request.body.razorpay_payment_id ?? "");
  const signature = String(request.body.razorpay_signature ?? "");
  if (!orderId || !paymentId || !signature) {
    throw new HttpError(400, "Incomplete Razorpay payment response.");
  }
  verifyCheckoutSignature(orderId, paymentId, signature);
  const [order, payment] = await Promise.all([
    razorpayRequest<WhiteLabelPartnerRazorpayOrder>(`/orders/${encodeURIComponent(orderId)}`),
    razorpayRequest<WhiteLabelPartnerRazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`),
  ]);
  if (order.notes?.whiteLabelAccountId !== account.id) {
    throw new HttpError(403, "This Razorpay order belongs to another white-label account.");
  }
  const invoice = await settleWhiteLabelPartnerOrder(order, payment);
  response.json({ success: true, invoice });
}
