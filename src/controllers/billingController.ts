import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { BillingInvoiceModel } from "../models/BillingInvoice.js";
import { BillingSubscriptionModel } from "../models/BillingSubscription.js";
import { OrganizationModel } from "../models/Organization.js";
import {
  billingUsage,
  creditBillingSettings,
  ensureBillingSubscription,
  ensureCreditWallet,
  planCatalog,
  recentCreditTransactions,
  recordCreditTopUp,
  type PlanId,
  stripeConfigured,
  stripeGet,
  stripePriceForPlan,
  stripeRequest,
  updateAutoReloadSettings,
} from "../services/billingService.js";
import { HttpError } from "../utils/httpError.js";

function orgId(request: AuthenticatedRequest) {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

export async function billingSummary(request: AuthenticatedRequest, response: Response) {
  const id = orgId(request);
  const [subscription, wallet, usage, invoices, transactions] = await Promise.all([
    ensureBillingSubscription(id),
    ensureCreditWallet(id),
    billingUsage(id),
    BillingInvoiceModel.find({ orgId: id }).sort({ createdAt: -1 }).limit(12),
    recentCreditTransactions(id, 25),
  ]);
  response.json({
    configured: stripeConfigured(),
    subscription,
    wallet,
    creditSettings: creditBillingSettings,
    currentPlan: planCatalog[subscription.plan as PlanId] ?? planCatalog.free,
    plans: Object.values(planCatalog),
    usage,
    invoices,
    transactions,
  });
}

function topUpAmount(value: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 1 || amount > 10000) {
    throw new HttpError(400, "Choose a credit amount between $1 and $10,000.");
  }
  return Math.round(amount * 100) / 100;
}

export async function createCreditTopUp(request: AuthenticatedRequest, response: Response) {
  if (!stripeConfigured()) {
    throw new HttpError(503, "Stripe checkout and webhooks must be configured before selling credits.");
  }
  const id = orgId(request);
  const amount = topUpAmount(request.body.amountCredits);
  const wallet = await ensureCreditWallet(id);
  const session = await stripeRequest<{ url: string }>("/checkout/sessions", {
    mode: "payment",
    success_url: `${env.clientUrl}/dashboard/billing?credits=success`,
    cancel_url: `${env.clientUrl}/dashboard/billing?credits=cancelled`,
    client_reference_id: id,
    "metadata[kind]": "credit_topup",
    "metadata[orgId]": id,
    "metadata[credits]": amount.toFixed(2),
    "payment_intent_data[metadata][kind]": "credit_topup",
    "payment_intent_data[metadata][orgId]": id,
    "payment_intent_data[metadata][credits]": amount.toFixed(2),
    "payment_intent_data[setup_future_usage]": "off_session",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][product_data][name]": `AI Voice Platform credits ($${amount.toFixed(2)})`,
    "line_items[0][price_data][unit_amount]": String(Math.round(amount * 100)),
    "line_items[0][quantity]": "1",
    ...(wallet.stripeCustomerId
      ? { customer: wallet.stripeCustomerId }
      : request.user?.email
        ? { customer_email: request.user.email, customer_creation: "always" }
        : {}),
  });
  response.json({ url: session.url });
}

export async function saveAutoReload(request: AuthenticatedRequest, response: Response) {
  const id = orgId(request);
  const wallet = await updateAutoReloadSettings(id, {
    enabled: request.body.enabled === true,
    thresholdCredits: Number(request.body.thresholdCredits),
    reloadAmountCredits: Number(request.body.reloadAmountCredits),
  });
  response.json({ wallet });
}

export async function listBillingTransactions(request: AuthenticatedRequest, response: Response) {
  response.json({ transactions: await recentCreditTransactions(orgId(request), Number(request.query.limit) || 50) });
}

export async function createCheckout(request: AuthenticatedRequest, response: Response) {
  const id = orgId(request);
  const plan = request.body.plan as PlanId;
  if (!["starter", "growth", "enterprise"].includes(plan)) throw new HttpError(400, "Choose a paid plan.");
  const price = stripePriceForPlan(plan);
  if (!price) throw new HttpError(503, `Stripe price for ${plan} is not configured.`);
  const subscription = await ensureBillingSubscription(id);
  const session = await stripeRequest<{ url: string }>("/checkout/sessions", {
    mode: "subscription",
    success_url: `${env.clientUrl}/dashboard/billing?checkout=success`,
    cancel_url: `${env.clientUrl}/dashboard/billing?checkout=cancelled`,
    client_reference_id: id,
    "metadata[orgId]": id,
    "metadata[plan]": plan,
    "subscription_data[metadata][orgId]": id,
    "subscription_data[metadata][plan]": plan,
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    ...(subscription.stripeCustomerId ? { customer: subscription.stripeCustomerId } : {}),
  });
  response.json({ url: session.url });
}

export async function createPortal(request: AuthenticatedRequest, response: Response) {
  const id = orgId(request);
  const [subscription, wallet] = await Promise.all([
    ensureBillingSubscription(id),
    ensureCreditWallet(id),
  ]);
  const customer = wallet.stripeCustomerId || subscription.stripeCustomerId;
  if (!customer) throw new HttpError(409, "No Stripe customer exists for this organization.");
  const session = await stripeRequest<{ url: string }>("/billing_portal/sessions", {
    customer,
    return_url: `${env.clientUrl}/dashboard/billing`,
  });
  response.json({ url: session.url });
}

type StripeObject = {
  id: string;
  customer?: string;
  subscription?: string;
  status?: string;
  client_reference_id?: string;
  metadata?: { orgId?: string; plan?: PlanId; kind?: string; credits?: string };
  items?: { data?: { price?: { id?: string } }[] };
  current_period_start?: number;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  amount_due?: number;
  amount_paid?: number;
  currency?: string;
  hosted_invoice_url?: string;
  invoice_pdf?: string;
  period_start?: number;
  period_end?: number;
  amount_total?: number;
  amount?: number;
  payment_intent?: string;
  payment_method?: string;
};

type BillingStatus = "active" | "trialing" | "past_due" | "cancelled" | "incomplete";

function billingStatus(status?: string): BillingStatus {
  if (status === "active" || status === "trialing" || status === "past_due") return status;
  if (status === "canceled" || status === "unpaid" || status === "paused") return "cancelled";
  return "incomplete";
}

function planFromPrice(priceId?: string): PlanId | undefined {
  if (!priceId) return undefined;
  return (["starter", "growth", "enterprise"] as const).find(
    (plan) => stripePriceForPlan(plan) === priceId,
  );
}

async function resolveWebhookOrgId(object: StripeObject) {
  const directId = object.metadata?.orgId ?? object.client_reference_id;
  if (directId) return directId;
  const existing = await BillingSubscriptionModel.findOne({
    $or: [
      ...(object.customer ? [{ stripeCustomerId: object.customer }] : []),
      ...(object.subscription ? [{ stripeSubscriptionId: object.subscription }] : []),
      ...(object.id ? [{ stripeSubscriptionId: object.id }] : []),
    ],
  });
  return existing?.orgId.toString();
}

function verifyStripeSignature(body: string, signature: string) {
  if (!env.stripeWebhookSecret) throw new HttpError(503, "Stripe webhook secret is not configured.");
  const parts = Object.fromEntries(signature.split(",").map((part) => part.split("=", 2)));
  const timestamp = parts.t;
  const provided = parts.v1;
  if (!timestamp || !provided || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    throw new HttpError(400, "Invalid Stripe webhook signature.");
  }
  const expected = createHmac("sha256", env.stripeWebhookSecret).update(`${timestamp}.${body}`).digest("hex");
  if (provided.length !== expected.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    throw new HttpError(400, "Invalid Stripe webhook signature.");
  }
}

export async function receiveStripeWebhook(request: Request, response: Response) {
  const body = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : String(request.body);
  verifyStripeSignature(body, String(request.headers["stripe-signature"] ?? ""));
  const event = JSON.parse(body) as { type: string; data: { object: StripeObject } };
  const object = event.data.object;
  const metadata = object.metadata ?? {};
  const id = await resolveWebhookOrgId(object);

  if (event.type === "checkout.session.completed" && metadata.kind === "credit_topup" && id) {
    const credits = Number(metadata.credits) || ((object.amount_total ?? 0) / 100);
    let paymentMethodId = "";
    if (object.payment_intent) {
      const intent = await stripeGet<{ payment_method?: string }>(`/payment_intents/${object.payment_intent}`);
      paymentMethodId = intent.payment_method ?? "";
    }
    await recordCreditTopUp({
      orgId: id,
      amountCredits: credits,
      stripeSessionId: object.id,
      stripePaymentIntentId: object.payment_intent ?? "",
      stripeCustomerId: object.customer ?? "",
      stripePaymentMethodId: paymentMethodId,
      description: `Stripe credit top-up: $${credits.toFixed(2)}`,
    });
  } else if (event.type === "payment_intent.succeeded" && metadata.kind === "credit_auto_reload" && id) {
    const credits = Number(metadata.credits) || ((object.amount ?? 0) / 100);
    await recordCreditTopUp({
      orgId: id,
      amountCredits: credits,
      type: "auto_reload",
      category: "auto_reload",
      stripePaymentIntentId: object.id,
      stripeCustomerId: object.customer ?? "",
      stripePaymentMethodId: object.payment_method ?? "",
      description: `Auto refill: $${credits.toFixed(2)}`,
    });
  } else if (event.type === "checkout.session.completed" && id) {
    await BillingSubscriptionModel.findOneAndUpdate(
      { orgId: id },
      {
        provider: "stripe",
        stripeCustomerId: object.customer ?? "",
        stripeSubscriptionId: object.subscription ?? "",
        plan: metadata.plan ?? "starter",
        status: "active",
      },
      { upsert: true, new: true, runValidators: true },
    );
    await OrganizationModel.findByIdAndUpdate(id, { plan: metadata.plan ?? "starter" });
  } else if (event.type.startsWith("customer.subscription.") && id) {
    const plan = metadata.plan ?? planFromPrice(object.items?.data?.[0]?.price?.id) ?? "starter";
    await BillingSubscriptionModel.findOneAndUpdate(
      { orgId: id },
      {
        provider: "stripe",
        stripeCustomerId: object.customer ?? "",
        stripeSubscriptionId: object.id,
        stripePriceId: object.items?.data?.[0]?.price?.id ?? "",
        plan,
        status: billingStatus(object.status),
        currentPeriodStart: object.current_period_start ? new Date(object.current_period_start * 1000) : undefined,
        currentPeriodEnd: object.current_period_end ? new Date(object.current_period_end * 1000) : undefined,
        cancelAtPeriodEnd: object.cancel_at_period_end ?? false,
      },
      { upsert: true, new: true, runValidators: true },
    );
    await OrganizationModel.findByIdAndUpdate(id, { plan });
  } else if (event.type.startsWith("invoice.") && id) {
    await BillingInvoiceModel.findOneAndUpdate(
      { stripeInvoiceId: object.id },
      {
        orgId: id,
        stripeInvoiceId: object.id,
        status: object.status ?? "",
        amountDue: object.amount_due ?? 0,
        amountPaid: object.amount_paid ?? 0,
        currency: object.currency ?? "usd",
        hostedInvoiceUrl: object.hosted_invoice_url ?? "",
        invoicePdf: object.invoice_pdf ?? "",
        periodStart: object.period_start ? new Date(object.period_start * 1000) : undefined,
        periodEnd: object.period_end ? new Date(object.period_end * 1000) : undefined,
      },
      { upsert: true, new: true, runValidators: true },
    );
  }
  response.status(204).end();
}
