import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { BillingInvoiceModel } from "../models/BillingInvoice.js";
import { BillingProviderConfigModel } from "../models/BillingProviderConfig.js";
import { BillingSubscriptionModel } from "../models/BillingSubscription.js";
import { CreditWalletModel } from "../models/CreditWallet.js";
import { OrganizationModel } from "../models/Organization.js";
import { RazorpayWebhookEventModel } from "../models/RazorpayWebhookEvent.js";
import { UserModel } from "../models/User.js";
import { ensureCreditWallet, recordCreditTopUp } from "../services/billingService.js";
import { sendTransactionalEmail } from "../services/emailService.js";
import { razorpayConfigured, razorpayRequest } from "../services/razorpayService.js";
import { HttpError } from "../utils/httpError.js";

type RazorpayOrder = {
  id: string;
  amount: number;
  amount_paid: number;
  currency: string;
  receipt?: string;
  status: "created" | "attempted" | "paid";
  notes?: Record<string, string>;
};

type RazorpayPayment = {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  method?: string;
  email?: string;
  contact?: string;
  notes?: Record<string, string>;
  captured?: boolean;
  created_at?: number;
};

type RazorpaySubscription = {
  id: string;
  plan_id: string;
  customer_id?: string;
  status: "created" | "authenticated" | "active" | "pending" | "halted" | "cancelled" | "completed" | "expired" | "paused";
  current_start?: number | null;
  current_end?: number | null;
  ended_at?: number | null;
  total_count?: number;
  paid_count?: number;
  remaining_count?: number;
  short_url?: string;
  has_scheduled_changes?: boolean;
  change_scheduled_at?: number | null;
  notes?: Record<string, string>;
};

type RazorpayInvoice = {
  id: string;
  order_id?: string;
  payment_id?: string;
  subscription_id?: string;
  status?: string;
  amount?: number;
  amount_paid?: number;
  amount_due?: number;
  currency?: string;
  short_url?: string;
  issued_at?: number;
  paid_at?: number;
  created_at?: number;
  notes?: Record<string, string>;
};

const ENTERPRISE_MONTHLY_CREDITS = env.razorpayEnterpriseMonthlyUsd;
const ENTERPRISE_MONTHLY_CENTS = Math.round(env.razorpayEnterpriseMonthlyUsd * 100);

function activeOrgId(request: AuthenticatedRequest) {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

function topUpCredits(value: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 1 || amount > 10_000) {
    throw new HttpError(400, "Choose a credit amount between $1 and $10,000.");
  }
  return Math.round(amount * 100) / 100;
}

function safeEqualHex(provided: string, expected: string) {
  return provided.length === expected.length
    && timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
}

function verifyHmac(payload: string, signature: string, secret: string, errorMessage: string) {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  if (!signature || !safeEqualHex(signature, expected)) throw new HttpError(400, errorMessage);
}

function verifyWebhookSignature(body: string, signature: string) {
  if (!env.razorpayWebhookSecret) throw new HttpError(503, "RAZORPAY_WEBHOOK_SECRET is not configured.");
  verifyHmac(body, signature, env.razorpayWebhookSecret, "Invalid Razorpay webhook signature.");
}

function creditsFromNotes(notes?: Record<string, string>) {
  const credits = Number(notes?.credits);
  if (!Number.isFinite(credits) || credits <= 0) throw new HttpError(400, "Razorpay entity has invalid credit metadata.");
  return Math.round(credits * 100) / 100;
}

function subscriptionStatus(status: RazorpaySubscription["status"]) {
  if (status === "created") return "incomplete";
  if (status === "authenticated") return "trialing";
  if (status === "pending" || status === "halted") return "past_due";
  if (status === "cancelled" || status === "completed" || status === "expired") return "cancelled";
  return "active";
}

async function ensureEnterprisePlan() {
  const configKey = `razorpay:plan:enterprise:usd:monthly:${ENTERPRISE_MONTHLY_CENTS}`;
  const configured = await BillingProviderConfigModel.findOne({ key: configKey });
  if (configured?.value) return configured.value;

  const plan = await razorpayRequest<{ id: string }>("/plans", {
    method: "POST",
    body: {
      period: "monthly",
      interval: 1,
      item: {
        name: "Vozon Enterprise Credits",
        amount: ENTERPRISE_MONTHLY_CENTS,
        currency: "USD",
        description: `$${ENTERPRISE_MONTHLY_CREDITS} in Vozon voice credits every month`,
      },
      notes: { product: "vozon_enterprise", credits: String(ENTERPRISE_MONTHLY_CREDITS) },
    },
  });
  const saved = await BillingProviderConfigModel.findOneAndUpdate(
    { key: configKey },
    { $setOnInsert: { key: configKey, value: plan.id } },
    { upsert: true, new: true, runValidators: true },
  );
  return saved.value;
}

async function saveSubscription(orgId: string, subscription: RazorpaySubscription) {
  return BillingSubscriptionModel.findOneAndUpdate(
    { orgId },
    {
      provider: "razorpay",
      plan: "enterprise",
      status: subscriptionStatus(subscription.status),
      razorpayPlanId: subscription.plan_id,
      razorpaySubscriptionId: subscription.id,
      razorpayCustomerId: subscription.customer_id ?? "",
      currentPeriodStart: subscription.current_start ? new Date(subscription.current_start * 1000) : undefined,
      currentPeriodEnd: subscription.current_end ? new Date(subscription.current_end * 1000) : undefined,
      cancelAtPeriodEnd: Boolean(subscription.has_scheduled_changes || subscription.change_scheduled_at),
    },
    { upsert: true, new: true, runValidators: true },
  );
}

async function saveInvoice(invoice: RazorpayInvoice, orgId: string, description: string) {
  const createdAt = invoice.paid_at ?? invoice.issued_at ?? invoice.created_at;
  return BillingInvoiceModel.findOneAndUpdate(
    { razorpayInvoiceId: invoice.id },
    {
      $setOnInsert: {
        orgId,
        provider: "razorpay",
        razorpayInvoiceId: invoice.id,
        razorpayOrderId: invoice.order_id ?? "",
        razorpayPaymentId: invoice.payment_id ?? "",
        invoiceNumber: `VZN-${invoice.id.replace(/^inv_/, "").slice(-12).toUpperCase()}`,
        description,
        periodStart: createdAt ? new Date(createdAt * 1000) : new Date(),
        periodEnd: createdAt ? new Date(createdAt * 1000) : new Date(),
      },
      $set: {
        status: invoice.status ?? "",
        amountDue: invoice.amount_due ?? invoice.amount ?? 0,
        amountPaid: invoice.amount_paid ?? 0,
        currency: (invoice.currency ?? "USD").toLowerCase(),
        hostedInvoiceUrl: invoice.short_url ?? "",
      },
    },
    { upsert: true, new: true, runValidators: true },
  );
}

async function persistOrderPayment(order: RazorpayOrder, payment: RazorpayPayment) {
  const orgId = order.notes?.orgId;
  if (!orgId) throw new HttpError(400, "Razorpay order is missing organization metadata.");
  if (payment.order_id !== order.id || payment.amount !== order.amount || payment.currency !== order.currency) {
    throw new HttpError(400, "Razorpay payment does not match its order.");
  }
  if (payment.status !== "captured" || order.status !== "paid") throw new HttpError(409, "Razorpay payment is not captured yet.");

  const credits = creditsFromNotes(order.notes);
  const transaction = await recordCreditTopUp({
    orgId,
    amountCredits: credits,
    paymentProvider: "razorpay",
    razorpayOrderId: order.id,
    razorpayPaymentId: payment.id,
    description: `Razorpay credit top-up: $${credits.toFixed(2)}`,
  });
  const paidAt = payment.created_at ? new Date(payment.created_at * 1000) : new Date();
  const invoice = await BillingInvoiceModel.findOneAndUpdate(
    { razorpayPaymentId: payment.id },
    {
      $setOnInsert: {
        orgId,
        provider: "razorpay",
        razorpayOrderId: order.id,
        razorpayPaymentId: payment.id,
        invoiceNumber: `VZN-${payment.id.replace(/^pay_/, "").slice(-12).toUpperCase()}`,
        description: `Vozon wallet credit purchase ($${credits.toFixed(2)} credits)`,
        amountDue: order.amount,
        amountPaid: payment.amount,
        currency: payment.currency.toLowerCase(),
        periodStart: paidAt,
        periodEnd: paidAt,
      },
      $set: { status: "paid" },
    },
    { upsert: true, new: true, runValidators: true },
  );
  return { transaction, invoice, credits };
}

async function persistSubscriptionCharge(subscription: RazorpaySubscription, payment: RazorpayPayment, invoice?: RazorpayInvoice) {
  const orgId = subscription.notes?.orgId;
  if (!orgId) throw new HttpError(400, "Razorpay subscription is missing organization metadata.");
  if (payment.status !== "captured") throw new HttpError(409, "Subscription payment is not captured.");
  const credits = creditsFromNotes(subscription.notes);
  const transaction = await recordCreditTopUp({
    orgId,
    amountCredits: credits,
    type: "auto_reload",
    category: "auto_reload",
    paymentProvider: "razorpay",
    razorpayOrderId: payment.order_id,
    razorpayPaymentId: payment.id,
    description: `Razorpay Enterprise monthly credits: $${credits.toFixed(2)}`,
  });
  await saveSubscription(orgId, subscription);
  if (invoice) await saveInvoice(invoice, orgId, "Vozon Enterprise monthly subscription");
  return { transaction, credits };
}

export async function createRazorpayTopUp(request: AuthenticatedRequest, response: Response) {
  if (!razorpayConfigured()) throw new HttpError(503, "Razorpay credentials are not configured.");
  const orgId = activeOrgId(request);
  const credits = topUpCredits(request.body.amountCredits);
  await ensureCreditWallet(orgId);
  const order = await razorpayRequest<RazorpayOrder>("/orders", {
    method: "POST",
    body: {
      amount: Math.round(credits * 100),
      currency: "USD",
      receipt: `vzn_${orgId.slice(-8)}_${Date.now().toString(36)}`.slice(0, 40),
      notes: { orgId, credits: credits.toFixed(2), kind: "credit_topup" },
    },
  });
  response.status(201).json({
    provider: "razorpay",
    kind: "order",
    keyId: env.razorpayKeyId,
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    credits,
    name: "Vozon.ai",
    description: `Add $${credits.toFixed(2)} in voice credits`,
    prefill: { name: request.user?.name ?? "", email: request.user?.email ?? "" },
  });
}

export async function verifyRazorpayPayment(request: AuthenticatedRequest, response: Response) {
  const orgId = activeOrgId(request);
  const orderId = String(request.body.razorpay_order_id ?? "");
  const paymentId = String(request.body.razorpay_payment_id ?? "");
  const signature = String(request.body.razorpay_signature ?? "");
  if (!orderId || !paymentId || !signature) throw new HttpError(400, "Incomplete Razorpay payment response.");
  verifyHmac(`${orderId}|${paymentId}`, signature, env.razorpayKeySecret, "Invalid Razorpay payment signature.");

  const [order, payment] = await Promise.all([
    razorpayRequest<RazorpayOrder>(`/orders/${encodeURIComponent(orderId)}`),
    razorpayRequest<RazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`),
  ]);
  if (order.notes?.orgId !== orgId) throw new HttpError(403, "This Razorpay order belongs to another organization.");
  const result = await persistOrderPayment(order, payment);
  response.json({ success: true, credits: result.credits, invoiceId: result.invoice.id });
}

export async function createEnterpriseSubscription(request: AuthenticatedRequest, response: Response) {
  const orgId = activeOrgId(request);
  const existing = await BillingSubscriptionModel.findOne({
    orgId,
    provider: "razorpay",
    status: { $in: ["active", "trialing", "incomplete", "past_due"] },
    razorpaySubscriptionId: { $ne: "" },
  });
  if (existing) throw new HttpError(409, "A Razorpay subscription already exists for this organization.");

  const planId = await ensureEnterprisePlan();
  const subscription = await razorpayRequest<RazorpaySubscription>("/subscriptions", {
    method: "POST",
    body: {
      plan_id: planId,
      total_count: 120,
      quantity: 1,
      customer_notify: true,
      notes: {
        orgId,
        credits: String(ENTERPRISE_MONTHLY_CREDITS),
        kind: "enterprise_monthly",
      },
    },
  });
  await saveSubscription(orgId, subscription);
  response.status(201).json({
    provider: "razorpay",
    kind: "subscription",
    keyId: env.razorpayKeyId,
    subscriptionId: subscription.id,
    amount: ENTERPRISE_MONTHLY_CENTS,
    currency: "USD",
    name: "Vozon.ai",
    description: `$${ENTERPRISE_MONTHLY_CREDITS} monthly Enterprise voice credits`,
    prefill: { name: request.user?.name ?? "", email: request.user?.email ?? "" },
  });
}

export async function verifyEnterpriseSubscription(request: AuthenticatedRequest, response: Response) {
  const orgId = activeOrgId(request);
  const subscriptionId = String(request.body.razorpay_subscription_id ?? "");
  const paymentId = String(request.body.razorpay_payment_id ?? "");
  const signature = String(request.body.razorpay_signature ?? "");
  if (!subscriptionId || !paymentId || !signature) throw new HttpError(400, "Incomplete Razorpay subscription response.");
  verifyHmac(`${paymentId}|${subscriptionId}`, signature, env.razorpayKeySecret, "Invalid Razorpay subscription signature.");

  const [subscription, payment] = await Promise.all([
    razorpayRequest<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}`),
    razorpayRequest<RazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`),
  ]);
  if (subscription.notes?.orgId !== orgId) throw new HttpError(403, "This subscription belongs to another organization.");
  await saveSubscription(orgId, subscription);
  if (payment.status === "captured") await persistSubscriptionCharge(subscription, payment);
  response.json({ success: true, status: subscriptionStatus(subscription.status) });
}

export async function cancelEnterpriseSubscription(request: AuthenticatedRequest, response: Response) {
  const orgId = activeOrgId(request);
  const local = await BillingSubscriptionModel.findOne({ orgId, provider: "razorpay", razorpaySubscriptionId: { $ne: "" } });
  if (!local?.razorpaySubscriptionId) throw new HttpError(404, "No Razorpay subscription exists.");
  const subscription = await razorpayRequest<RazorpaySubscription>(
    `/subscriptions/${encodeURIComponent(local.razorpaySubscriptionId)}/cancel`,
    { method: "POST", body: { cancel_at_cycle_end: request.body.immediate !== true } },
  );
  await saveSubscription(orgId, subscription);
  response.json({ subscription });
}

export async function listRazorpayInvoices(request: AuthenticatedRequest, response: Response) {
  const invoices = await BillingInvoiceModel.find({ orgId: activeOrgId(request) }).sort({ createdAt: -1 }).limit(50);
  response.json({ invoices });
}

export async function downloadBillingInvoice(request: AuthenticatedRequest, response: Response) {
  const invoice = await BillingInvoiceModel.findOne({ _id: request.params.invoiceId, orgId: activeOrgId(request) });
  if (!invoice) throw new HttpError(404, "Invoice not found.");
  const organization = await OrganizationModel.findById(invoice.orgId).select("name ownerUserId");
  const owner = organization ? await UserModel.findById(organization.ownerUserId).select("name email") : null;
  const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: invoice.currency.toUpperCase() }).format(invoice.amountPaid / 100);
  const amountDue = new Intl.NumberFormat("en-US", { style: "currency", currency: invoice.currency.toUpperCase() }).format(invoice.amountDue / 100);
  const invoiceDate = (invoice.get("createdAt") as Date | undefined)?.toISOString().slice(0, 10) ?? "";
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Disposition", `inline; filename="${escape(invoice.invoiceNumber || invoice.id)}.html"`);
  response.send(`<!doctype html><html><head><meta charset="utf-8"><title>${escape(invoice.invoiceNumber)}</title><style>body{font:15px Arial;color:#172033;margin:48px}.wrap{max-width:760px;margin:auto}.top{display:flex;justify-content:space-between;border-bottom:3px solid #10b981;padding-bottom:24px}h1{margin:0}.meta,.total{margin-top:32px}.meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}.row{display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid #e5e7eb}.total{font-size:22px;font-weight:700;text-align:right}.muted{color:#64748b}@media(max-width:600px){body{margin:20px}.meta-grid{grid-template-columns:1fr}}@media print{button{display:none}}</style></head><body><div class="wrap"><div class="top"><div><h1>VOZON.AI</h1><p>Payment invoice</p></div><div><strong>${escape(invoice.invoiceNumber)}</strong><p>${escape(invoiceDate)}</p></div></div><div class="meta meta-grid"><div><strong>Billed to</strong><p>${escape(organization?.name ?? owner?.name ?? "Customer")}<br>${escape(owner?.email ?? "")}</p></div><div><strong>Payment details</strong><p>Status: ${escape(invoice.status.toUpperCase())}<br>Provider: Razorpay<br>Payment ID: ${escape(invoice.razorpayPaymentId)}<br>Order ID: ${escape(invoice.razorpayOrderId)}</p></div></div><div class="row"><span>${escape(invoice.description)}</span><strong>${escape(amountDue)}</strong></div><div class="total">Total paid: ${escape(amount)}</div><p class="muted" style="margin-top:48px">This electronically generated payment invoice records the Vozon.ai service purchase. Tax registration details must be configured separately where legally required.</p><button onclick="print()">Print / Save PDF</button></div></body></html>`);
}

async function resolveSubscription(eventSubscription?: RazorpaySubscription, payment?: RazorpayPayment) {
  if (eventSubscription) return eventSubscription;
  const subscriptionId = payment?.notes?.subscription_id;
  return subscriptionId
    ? razorpayRequest<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}`)
    : null;
}

async function notifyFailedSubscriptionPayment(subscription: RazorpaySubscription | null, payment: RazorpayPayment) {
  if (!subscription) return;
  const orgId = subscription.notes?.orgId;
  if (!orgId) return;
  const organization = await OrganizationModel.findById(orgId).select("name ownerUserId");
  if (!organization) return;
  const owner = await UserModel.findById(organization.ownerUserId).select("name email");
  if (!owner?.email) return;
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: payment.currency || "USD" }).format(payment.amount / 100);
  await sendTransactionalEmail({
    userId: owner.id,
    to: owner.email,
    kind: "billing",
    subject: "Action required: Vozon Autopay failed",
    text: `Hi ${owner.name},\n\nYour ${amount} Vozon monthly Autopay could not be completed. Razorpay will retry automatically. Please ensure your card is active and has sufficient funds.\n\nSubscription: ${subscription.id}\nPayment: ${payment.id}\n\nIf the payment continues to fail, contact ${env.supportInbox}.`,
  });
}

export async function receiveRazorpayWebhook(request: Request, response: Response) {
  const body = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : String(request.body);
  verifyWebhookSignature(body, String(request.headers["x-razorpay-signature"] ?? ""));
  const event = JSON.parse(body) as {
    event?: string;
    payload?: {
      payment?: { entity?: RazorpayPayment };
      order?: { entity?: RazorpayOrder };
      subscription?: { entity?: RazorpaySubscription };
      invoice?: { entity?: RazorpayInvoice };
    };
  };
  const payment = event.payload?.payment?.entity;
  const order = event.payload?.order?.entity;
  const subscription = event.payload?.subscription?.entity;
  const invoice = event.payload?.invoice?.entity;
  const digest = createHash("sha256").update(body).digest("hex");
  let webhookLog;
  try {
    webhookLog = await RazorpayWebhookEventModel.create({ digest, event: event.event || "unknown" });
  } catch (error) {
    const existing = await RazorpayWebhookEventModel.findOne({ digest });
    if (!existing) throw error;
    if (existing.status === "processed") {
      response.status(204).end();
      return;
    }
    if (existing.status === "processing" && existing.updatedAt.getTime() > Date.now() - 5 * 60_000) {
      response.status(204).end();
      return;
    }
    webhookLog = await RazorpayWebhookEventModel.findByIdAndUpdate(
      existing._id,
      { $set: { status: "processing", errorMessage: "" }, $inc: { attempts: 1 } },
      { new: true },
    );
  }

  try {

  if ((event.event === "order.paid" || event.event === "payment.captured") && payment) {
    const resolvedOrder = order ?? await razorpayRequest<RazorpayOrder>(`/orders/${encodeURIComponent(payment.order_id)}`);
    if (resolvedOrder.notes?.kind === "credit_topup") await persistOrderPayment(resolvedOrder, payment);
  }

  if (event.event === "subscription.charged" && subscription && payment) {
    await persistSubscriptionCharge(subscription, payment, invoice);
  } else if (event.event?.startsWith("subscription.") && subscription) {
    const orgId = subscription.notes?.orgId;
    if (orgId) await saveSubscription(orgId, subscription);
  }

  if (event.event?.startsWith("invoice.") && invoice) {
    const local = invoice.subscription_id
      ? await BillingSubscriptionModel.findOne({ razorpaySubscriptionId: invoice.subscription_id })
      : null;
    const orgId = invoice.notes?.orgId ?? local?.orgId?.toString();
    if (orgId) await saveInvoice(invoice, orgId, "Vozon Enterprise monthly subscription");
  }

  if (event.event === "payment.failed" && payment) {
    const failedSubscription = await resolveSubscription(subscription, payment);
    const localSubscription = failedSubscription
      ? await BillingSubscriptionModel.findOne({ razorpaySubscriptionId: failedSubscription.id })
      : null;
    const orgId = payment.notes?.orgId ?? failedSubscription?.notes?.orgId ?? localSubscription?.orgId?.toString();
    if (orgId) {
      await CreditWalletModel.updateOne(
        { orgId },
        { $set: { lastPaymentStatus: "failed", lastCheckedAt: new Date() } },
      );
    }
    if (failedSubscription) {
      void notifyFailedSubscriptionPayment(failedSubscription, payment).catch(() => undefined);
    }
  }
  await RazorpayWebhookEventModel.updateOne(
    { _id: webhookLog?._id },
    { $set: { status: "processed", processedAt: new Date(), errorMessage: "" } },
  );
  response.status(204).end();
  } catch (error) {
    await RazorpayWebhookEventModel.updateOne(
      { _id: webhookLog?._id },
      { $set: { status: "failed", errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) } },
    );
    throw error;
  }
}

export const razorpayBillingTestHelpers = {
  topUpCredits,
  subscriptionStatus,
  verifyHmac,
  enterpriseMonthlyCredits: ENTERPRISE_MONTHLY_CREDITS,
  enterpriseMonthlyCents: ENTERPRISE_MONTHLY_CENTS,
};
