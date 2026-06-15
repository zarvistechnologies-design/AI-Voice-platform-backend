import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { BillingInvoiceModel } from "../models/BillingInvoice.js";
import { BillingSubscriptionModel } from "../models/BillingSubscription.js";
import { OrganizationModel } from "../models/Organization.js";
import {
  billingUsage,
  ensureBillingSubscription,
  planCatalog,
  type PlanId,
  stripeConfigured,
  stripePriceForPlan,
  stripeRequest,
} from "../services/billingService.js";
import { HttpError } from "../utils/httpError.js";

function orgId(request: AuthenticatedRequest) {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

export async function billingSummary(request: AuthenticatedRequest, response: Response) {
  const id = orgId(request);
  const [subscription, usage, invoices] = await Promise.all([
    ensureBillingSubscription(id),
    billingUsage(id),
    BillingInvoiceModel.find({ orgId: id }).sort({ createdAt: -1 }).limit(12),
  ]);
  response.json({
    configured: stripeConfigured(),
    subscription,
    currentPlan: planCatalog[subscription.plan as PlanId] ?? planCatalog.free,
    plans: Object.values(planCatalog),
    usage,
    invoices,
  });
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
  const subscription = await ensureBillingSubscription(orgId(request));
  if (!subscription.stripeCustomerId) throw new HttpError(409, "No Stripe customer exists for this organization.");
  const session = await stripeRequest<{ url: string }>("/billing_portal/sessions", {
    customer: subscription.stripeCustomerId,
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
  metadata?: { orgId?: string; plan?: PlanId };
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

  if (event.type === "checkout.session.completed" && id) {
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
