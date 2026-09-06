import { randomBytes } from "node:crypto";

import { env } from "../config/env.js";
import { OrganizationModel } from "../models/Organization.js";
import { PlatformAuditLogModel } from "../models/PlatformAuditLog.js";
import { UserModel } from "../models/User.js";
import { WhiteLabelAccountModel } from "../models/WhiteLabelAccount.js";
import { WhiteLabelBrandModel } from "../models/WhiteLabelBrand.js";
import { WhiteLabelCustomerInvoiceModel } from "../models/WhiteLabelCustomerInvoice.js";
import { WhiteLabelDomainModel } from "../models/WhiteLabelDomain.js";
import { WhiteLabelSubscriptionModel } from "../models/WhiteLabelSubscription.js";
import { recordCreditTopUp } from "./billingService.js";
import { sendTransactionalEmail } from "./emailService.js";
import { razorpayRequest } from "./razorpayService.js";
import { HttpError } from "../utils/httpError.js";

export type WhiteLabelCustomerRazorpayOrder = {
  id: string;
  amount: number;
  currency: string;
  status: "created" | "attempted" | "paid";
  notes?: Record<string, string>;
};

export type WhiteLabelCustomerRazorpayPayment = {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  method?: string;
  amount_refunded?: number;
  refund_status?: "partial" | "full" | null;
};

export type WhiteLabelCustomerRazorpayTransfer = {
  id: string;
  source?: string;
  recipient?: string;
  amount?: number;
  currency?: string;
  status?: "pending" | "processed" | "failed" | "reversed";
};

export type WhiteLabelCustomerRazorpayRefund = {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  status: "pending" | "processed" | "failed";
};

export type WhiteLabelCustomerRazorpayDispute = {
  id: string;
  payment_id: string;
  amount?: number;
  currency?: string;
  reason_code?: string;
};

type WhiteLabelCustomerInvoicePaymentExpectation = {
  id: string;
  accountId: unknown;
  subscriptionId: unknown;
  orgId: unknown;
  status: string;
  totalMinor: number;
  currency: string;
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
};

function nextPeriod(from: Date, interval: unknown) {
  const end = new Date(from);
  if (interval === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}

function dateValue(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date : null;
}

export function calculateWhiteLabelCustomerInvoice(input: {
  recurringAmountMinor: number;
  setupFeeMinor?: number;
  taxBehavior?: "exclusive" | "inclusive" | "unspecified";
  taxRateBps?: number;
}) {
  const recurringAmountMinor = Math.max(0, Math.round(Number(input.recurringAmountMinor) || 0));
  const setupFeeMinor = Math.max(0, Math.round(Number(input.setupFeeMinor) || 0));
  const subtotalMinor = recurringAmountMinor + setupFeeMinor;
  const taxRateBps = Math.max(0, Math.min(100_000, Math.round(Number(input.taxRateBps) || 0)));
  const taxBehavior = input.taxBehavior === "exclusive" || input.taxBehavior === "inclusive"
    ? input.taxBehavior
    : "unspecified";
  if (taxRateBps > 0 && taxBehavior === "unspecified") {
    throw new HttpError(409, "Set the retail plan tax behavior before applying a configured tax rate.");
  }
  const taxMinor = taxRateBps <= 0
    ? 0
    : taxBehavior === "inclusive"
      ? Math.round(subtotalMinor * taxRateBps / (10_000 + taxRateBps))
      : Math.round(subtotalMinor * taxRateBps / 10_000);
  const totalMinor = taxBehavior === "inclusive" ? subtotalMinor : subtotalMinor + taxMinor;
  return { recurringAmountMinor, setupFeeMinor, subtotalMinor, taxBehavior, taxRateBps, taxMinor, totalMinor };
}

export function calculateWhiteLabelCustomerRefundTotal(input: {
  totalMinor: number;
  refundedMinor: number;
  lastRefundId?: string;
  refundId: string;
  refundAmount: number;
  providerCumulativeRefund?: number;
}) {
  const totalMinor = Math.max(0, Math.round(Number(input.totalMinor) || 0));
  const refundedMinor = Math.min(totalMinor, Math.max(0, Math.round(Number(input.refundedMinor) || 0)));
  const providerCumulative = Number(input.providerCumulativeRefund);
  const candidate = Number.isFinite(providerCumulative) && providerCumulative > 0
    ? providerCumulative
    : input.lastRefundId === input.refundId
      ? refundedMinor
      : refundedMinor + Math.max(0, Math.round(Number(input.refundAmount) || 0));
  return Math.min(totalMinor, Math.max(refundedMinor, candidate));
}

export function assertWhiteLabelCustomerPaymentMatches(
  invoice: WhiteLabelCustomerInvoicePaymentExpectation,
  order: WhiteLabelCustomerRazorpayOrder,
  payment: WhiteLabelCustomerRazorpayPayment,
) {
  const notes = order.notes ?? {};
  const metadataMatches = notes.kind === "white_label_customer_invoice"
    && notes.whiteLabelCustomerInvoiceId === invoice.id
    && notes.whiteLabelAccountId === String(invoice.accountId)
    && notes.whiteLabelSubscriptionId === String(invoice.subscriptionId)
    && notes.orgId === String(invoice.orgId);
  const paymentMatches = payment.status === "captured"
    && payment.order_id === order.id
    && order.status === "paid"
    && order.amount === invoice.totalMinor
    && payment.amount === invoice.totalMinor
    && order.currency.toUpperCase() === invoice.currency.toUpperCase()
    && payment.currency.toUpperCase() === invoice.currency.toUpperCase()
    && (!invoice.razorpayOrderId || invoice.razorpayOrderId === order.id)
    && (!invoice.razorpayPaymentId || invoice.razorpayPaymentId === payment.id);
  if (!metadataMatches || !paymentMatches) {
    throw new HttpError(409, "Razorpay payment does not match the retail invoice.");
  }
}

function invoiceNumber(accountSlug: string, orgId: string, periodStart: Date) {
  const period = periodStart.toISOString().slice(0, 10).replaceAll("-", "");
  const slug = accountSlug.replace(/[^a-z0-9]/gi, "").slice(0, 10).toUpperCase() || "PARTNER";
  const suffix = orgId.replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase();
  return `WLC-${period}-${slug}-${suffix}-${randomBytes(2).toString("hex").toUpperCase()}`;
}

async function notifyWhiteLabelCustomerBilling(
  invoiceId: string,
  kind: "invoice_due" | "payment_failed" | "past_due" | "paused" | "refunded" | "disputed" | "dispute_won",
) {
  const invoice = await WhiteLabelCustomerInvoiceModel.findById(invoiceId).lean();
  if (!invoice) return;
  const [organization, brand, appDomain] = await Promise.all([
    OrganizationModel.findById(invoice.orgId).select("name ownerUserId").lean(),
    WhiteLabelBrandModel.findById(invoice.brandId).select("branding email support").lean(),
    WhiteLabelDomainModel.findOne({ brandId: invoice.brandId, kind: "app", status: "active" })
      .select("hostname")
      .lean(),
  ]);
  if (!organization || !brand) return;
  const owner = await UserModel.findById(organization.ownerUserId).select("name email").lean();
  if (!owner?.email) return;
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: invoice.currency,
  }).format(invoice.totalMinor / 100);
  const productName = brand.branding?.productName || brand.branding?.companyName || "Voice service";
  const billingUrl = appDomain?.hostname ? `https://${appDomain.hostname}/dashboard/billing` : "";
  const subject = kind === "refunded"
    ? `${productName} payment was reversed`
    : kind === "disputed"
      ? `${productName} payment is under dispute review`
      : kind === "dispute_won"
        ? `${productName} payment dispute was resolved`
        : kind === "invoice_due"
    ? `${productName} invoice is ready`
    : kind === "payment_failed"
    ? `Action required: ${productName} payment failed`
    : kind === "paused"
      ? `${productName} service paused for unpaid invoice`
      : `${productName} invoice is past due`;
  const stateMessage = kind === "refunded"
    ? `The payment for invoice ${invoice.invoiceNumber} was fully reversed. Service is paused until the replacement invoice is paid.`
    : kind === "disputed"
      ? `The payment for invoice ${invoice.invoiceNumber} is under dispute review. Service is temporarily paused.`
      : kind === "dispute_won"
        ? `The payment dispute for invoice ${invoice.invoiceNumber} was resolved in the merchant's favor.`
        : kind === "invoice_due"
    ? `Invoice ${invoice.invoiceNumber} for ${amount} is ready for payment.`
    : kind === "payment_failed"
    ? `We could not complete the ${amount} payment for invoice ${invoice.invoiceNumber}.`
    : kind === "paused"
      ? `Service is paused because invoice ${invoice.invoiceNumber} for ${amount} remains unpaid.`
      : `Invoice ${invoice.invoiceNumber} for ${amount} is now past due.`;
  const actionMessage = billingUrl
    ? `Open Billing to complete payment: ${billingUrl}`
    : `Contact ${brand.support?.email || "your service provider"} to complete payment.`;
  await sendTransactionalEmail({
    userId: String(owner._id),
    to: owner.email,
    kind: "billing",
    subject,
    text: `Hi ${owner.name || "there"},\n\n${stateMessage}\n\n${actionMessage}\n\nInvoice: ${invoice.invoiceNumber}`,
    replyTo: brand.support?.email || undefined,
    fromName: brand.email?.fromName || productName,
    fromAddress: brand.email?.sendingDomainStatus === "verified"
      ? brand.email?.fromAddress || undefined
      : undefined,
    requireVerifiedFromAddress: true,
  });
}

async function notifyWhiteLabelCustomerBillingOnce(
  invoiceId: string,
  kind: "invoice_due" | "past_due" | "paused",
) {
  const field = kind === "invoice_due"
    ? "dueNoticeSentAt"
    : kind === "past_due"
      ? "pastDueNoticeSentAt"
      : "pausedNoticeSentAt";
  const claimed = await WhiteLabelCustomerInvoiceModel.findOneAndUpdate(
    { _id: invoiceId, [field]: { $exists: false } },
    { $set: { [field]: new Date() } },
    { new: true },
  );
  if (!claimed) return;
  try {
    await notifyWhiteLabelCustomerBilling(invoiceId, kind);
  } catch (error) {
    await WhiteLabelCustomerInvoiceModel.updateOne(
      { _id: invoiceId, [field]: claimed.get(field) },
      { $unset: { [field]: "" } },
    );
    throw error;
  }
}

function invoicePeriod(subscription: {
  priceSnapshot?: unknown;
  trialEndsAt?: Date | null;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
}, initial: boolean, now: Date) {
  const price = (subscription.priceSnapshot ?? {}) as Record<string, unknown>;
  if (initial) {
    const trialEndsAt = dateValue(subscription.trialEndsAt);
    const configuredStart = dateValue(subscription.currentPeriodStart);
    const start = trialEndsAt && trialEndsAt > now ? trialEndsAt : configuredStart ?? now;
    return { periodStart: start, periodEnd: nextPeriod(start, price.interval) };
  }
  const currentEnd = dateValue(subscription.currentPeriodEnd);
  const periodStart = currentEnd ?? now;
  return { periodStart, periodEnd: nextPeriod(periodStart, price.interval) };
}

export async function ensureWhiteLabelCustomerInvoice(orgId: string, now = new Date()) {
  const subscription = await WhiteLabelSubscriptionModel.findOne({ orgId });
  if (!subscription) throw new HttpError(404, "White-label customer subscription not found.");
  const account = await WhiteLabelAccountModel.findById(subscription.accountId);
  if (!account) throw new HttpError(404, "White-label account not found.");
  if (!account.retailBilling?.enabled) {
    throw new HttpError(409, "Retail payments are managed directly by your service provider.");
  }

  const existingOpen = await WhiteLabelCustomerInvoiceModel.findOne({
    subscriptionId: subscription._id,
    status: { $in: ["open", "past_due"] },
  }).sort({ createdAt: -1 });
  if (existingOpen) {
    await notifyWhiteLabelCustomerBillingOnce(existingOpen.id, "invoice_due").catch(() => undefined);
    return { account, subscription, invoice: existingOpen };
  }

  if (subscription.lastPaymentInvoiceId) {
    const refundedInvoice = await WhiteLabelCustomerInvoiceModel.findOne({
      _id: subscription.lastPaymentInvoiceId,
      subscriptionId: subscription._id,
      status: "refunded",
    });
    if (refundedInvoice) {
      let replacement = await WhiteLabelCustomerInvoiceModel.findOne({
        replacementOfInvoiceId: refundedInvoice._id,
      });
      if (!replacement) {
        try {
          replacement = await WhiteLabelCustomerInvoiceModel.create({
            accountId: refundedInvoice.accountId,
            brandId: refundedInvoice.brandId,
            orgId: refundedInvoice.orgId,
            subscriptionId: refundedInvoice.subscriptionId,
            invoiceNumber: invoiceNumber(account.slug, String(subscription.orgId), refundedInvoice.periodStart),
            kind: "replacement",
            sequence: refundedInvoice.sequence + 1,
            replacementOfInvoiceId: refundedInvoice._id,
            grantsAllowance: false,
            status: "open",
            provider: "razorpay",
            currency: refundedInvoice.currency,
            periodStart: refundedInvoice.periodStart,
            periodEnd: refundedInvoice.periodEnd,
            dueAt: now,
            recurringAmountMinor: refundedInvoice.recurringAmountMinor,
            setupFeeMinor: refundedInvoice.setupFeeMinor,
            subtotalMinor: refundedInvoice.subtotalMinor,
            taxBehavior: refundedInvoice.taxBehavior,
            taxRateBps: refundedInvoice.taxRateBps,
            taxLabel: refundedInvoice.taxLabel,
            taxRegistrationId: refundedInvoice.taxRegistrationId,
            taxMinor: refundedInvoice.taxMinor,
            totalMinor: refundedInvoice.totalMinor,
            transferMode: refundedInvoice.transferMode,
            razorpayLinkedAccountId: refundedInvoice.razorpayLinkedAccountId,
            transferStatus: refundedInvoice.transferMode === "full_amount" ? "pending" : "not_applicable",
          });
        } catch (error) {
          replacement = await WhiteLabelCustomerInvoiceModel.findOne({
            replacementOfInvoiceId: refundedInvoice._id,
          });
          if (!replacement) throw error;
        }
      }
      await notifyWhiteLabelCustomerBillingOnce(replacement.id, "invoice_due").catch(() => undefined);
      return { account, subscription, invoice: replacement };
    }
  }

  const previousPaid = await WhiteLabelCustomerInvoiceModel.findOne({
    subscriptionId: subscription._id,
    status: "paid",
  }).sort({ periodStart: -1 });
  const initial = !previousPaid;
  const currentPeriodEnd = dateValue(subscription.currentPeriodEnd);
  if (previousPaid && currentPeriodEnd && currentPeriodEnd > now) {
    return { account, subscription, invoice: previousPaid };
  }
  const { periodStart, periodEnd } = invoicePeriod(subscription, initial, now);
  const duplicate = await WhiteLabelCustomerInvoiceModel.findOne({
    subscriptionId: subscription._id,
    periodStart,
    kind: initial ? "initial" : "renewal",
  });
  if (duplicate) return { account, subscription, invoice: duplicate };

  const price = (subscription.priceSnapshot ?? {}) as Record<string, unknown>;
  const currency = String(price.currency ?? "USD").toUpperCase();
  if (currency !== "USD" && currency !== "INR") throw new HttpError(409, "Unsupported retail billing currency.");
  const transferMode = account.retailBilling?.transferMode ?? "disabled";
  const linkedAccountId = account.retailBilling?.razorpayLinkedAccountId?.trim() ?? "";
  if (transferMode === "full_amount" && (currency !== "INR" || !linkedAccountId)) {
    throw new HttpError(409, "Razorpay Route settlement requires an INR plan and a linked account.");
  }
  const calculation = calculateWhiteLabelCustomerInvoice({
    recurringAmountMinor: Number(price.recurringAmountMinor ?? 0),
    setupFeeMinor: initial ? Number(price.setupFeeMinor ?? 0) : 0,
    taxBehavior: price.taxBehavior as "exclusive" | "inclusive" | "unspecified" | undefined,
    taxRateBps: account.retailBilling?.taxRateBps,
  });
  const dueAt = initial && subscription.trialEndsAt && subscription.trialEndsAt > now
    ? subscription.trialEndsAt
    : now;
  let invoice;
  try {
    invoice = await WhiteLabelCustomerInvoiceModel.create({
      accountId: account._id,
      brandId: subscription.brandId,
      orgId: subscription.orgId,
      subscriptionId: subscription._id,
      invoiceNumber: invoiceNumber(account.slug, String(subscription.orgId), periodStart),
      kind: initial ? "initial" : "renewal",
      status: calculation.totalMinor === 0 ? "paid" : "open",
      provider: calculation.totalMinor === 0 ? "internal" : "razorpay",
      currency,
      periodStart,
      periodEnd,
      dueAt,
      ...calculation,
      taxLabel: account.retailBilling?.taxLabel || "Tax",
      taxRegistrationId: account.retailBilling?.taxRegistrationId || "",
      transferMode,
      razorpayLinkedAccountId: linkedAccountId,
      transferStatus: calculation.totalMinor > 0 && transferMode === "full_amount" ? "pending" : "not_applicable",
      ...(calculation.totalMinor === 0 ? { paidAt: now } : {}),
    });
  } catch (error) {
    const concurrent = await WhiteLabelCustomerInvoiceModel.findOne({
      subscriptionId: subscription._id,
      periodStart,
      kind: initial ? "initial" : "renewal",
    });
    if (!concurrent) throw error;
    invoice = concurrent;
  }
  if (invoice.status === "paid") await settleWhiteLabelCustomerInvoice(invoice.id, null, null, now);
  else await notifyWhiteLabelCustomerBillingOnce(invoice.id, "invoice_due").catch(() => undefined);
  return { account, subscription, invoice };
}

export async function razorpayOrderForWhiteLabelCustomer(orgId: string) {
  const { account, invoice } = await ensureWhiteLabelCustomerInvoice(orgId);
  if (invoice.status === "paid") return { account, invoice, order: null };
  if (invoice.status === "void" || invoice.status === "refunded") {
    throw new HttpError(409, "This retail invoice cannot be paid.");
  }
  if (!invoice.razorpayOrderId) {
    const transfers = invoice.transferMode === "full_amount"
      ? [{
          account: invoice.razorpayLinkedAccountId,
          amount: invoice.totalMinor,
          currency: "INR",
          on_hold: 0,
          notes: { whiteLabelCustomerInvoiceId: invoice.id, whiteLabelAccountId: String(invoice.accountId) },
        }]
      : undefined;
    const order = await razorpayRequest<WhiteLabelCustomerRazorpayOrder>("/orders", {
      method: "POST",
      body: {
        amount: invoice.totalMinor,
        currency: invoice.currency,
        receipt: invoice.invoiceNumber.slice(0, 40),
        partial_payment: false,
        ...(transfers ? { transfers } : {}),
        notes: {
          kind: "white_label_customer_invoice",
          whiteLabelAccountId: String(invoice.accountId),
          whiteLabelCustomerInvoiceId: invoice.id,
          whiteLabelSubscriptionId: String(invoice.subscriptionId),
          orgId: String(invoice.orgId),
          invoiceNumber: invoice.invoiceNumber,
        },
      },
    });
    const claimed = await WhiteLabelCustomerInvoiceModel.findOneAndUpdate(
      { _id: invoice._id, razorpayOrderId: { $in: [null, ""] }, status: { $in: ["open", "past_due"] } },
      { $set: { razorpayOrderId: order.id, provider: "razorpay" } },
      { new: true },
    );
    if (claimed) return { account, invoice: claimed, order };
    const current = await WhiteLabelCustomerInvoiceModel.findById(invoice._id);
    if (current?.status === "paid") return { account, invoice: current, order: null };
    if (current?.razorpayOrderId) {
      return {
        account,
        invoice: current,
        order: await razorpayRequest<WhiteLabelCustomerRazorpayOrder>(`/orders/${encodeURIComponent(current.razorpayOrderId)}`),
      };
    }
    throw new HttpError(409, "Retail checkout changed concurrently. Please retry.");
  }
  return {
    account,
    invoice,
    order: await razorpayRequest<WhiteLabelCustomerRazorpayOrder>(`/orders/${encodeURIComponent(invoice.razorpayOrderId)}`),
  };
}

export async function settleWhiteLabelCustomerOrder(
  order: WhiteLabelCustomerRazorpayOrder,
  payment: WhiteLabelCustomerRazorpayPayment,
) {
  const invoiceId = String(order.notes?.whiteLabelCustomerInvoiceId ?? "");
  const orgId = String(order.notes?.orgId ?? "");
  if (order.notes?.kind !== "white_label_customer_invoice" || !invoiceId || !orgId) {
    throw new HttpError(400, "Razorpay order is not a white-label customer invoice.");
  }
  const invoice = await WhiteLabelCustomerInvoiceModel.findOne({ _id: invoiceId, orgId });
  if (!invoice) throw new HttpError(404, "White-label customer invoice not found.");
  if (invoice.status === "void" || invoice.status === "refunded" || invoice.status === "disputed") {
    throw new HttpError(409, `Retail invoice is ${invoice.status} and cannot be settled.`);
  }
  assertWhiteLabelCustomerPaymentMatches({
    id: invoice.id,
    accountId: invoice.accountId,
    subscriptionId: invoice.subscriptionId,
    orgId: invoice.orgId,
    status: invoice.status,
    totalMinor: invoice.totalMinor,
    currency: invoice.currency,
    razorpayOrderId: invoice.razorpayOrderId,
    razorpayPaymentId: invoice.razorpayPaymentId,
  }, order, payment);
  return settleWhiteLabelCustomerInvoice(invoice.id, order, payment);
}

async function settleWhiteLabelCustomerInvoice(
  invoiceId: string,
  order: WhiteLabelCustomerRazorpayOrder | null,
  payment: WhiteLabelCustomerRazorpayPayment | null,
  paidAt = new Date(),
) {
  const invoice = await WhiteLabelCustomerInvoiceModel.findById(invoiceId);
  if (!invoice) throw new HttpError(404, "White-label customer invoice not found.");
  const settled = await WhiteLabelCustomerInvoiceModel.findOneAndUpdate(
    { _id: invoice._id, status: { $ne: "paid" } },
    {
      $set: {
        status: "paid",
        provider: payment ? "razorpay" : "internal",
        ...(order ? { razorpayOrderId: order.id } : {}),
        ...(payment ? { razorpayPaymentId: payment.id, paymentMethod: payment.method ?? "" } : {}),
        paidAt,
        failureMessage: "",
      },
    },
    { new: true, runValidators: true },
  );
  const result = settled ?? await WhiteLabelCustomerInvoiceModel.findById(invoice._id);
  if (!result || result.status !== "paid") throw new HttpError(409, "Retail invoice settlement changed concurrently.");
  const subscription = await WhiteLabelSubscriptionModel.findOneAndUpdate(
    { _id: result.subscriptionId, status: { $nin: ["cancelled", "expired"] } },
    {
      $set: {
        status: "active",
        currentPeriodStart: result.periodStart,
        currentPeriodEnd: result.periodEnd,
        lastPaymentAt: paidAt,
        lastPaymentInvoiceId: result._id,
        cancelAtPeriodEnd: false,
      },
      $unset: { trialEndsAt: "", pastDueAt: "", graceEndsAt: "", billingSuspendedAt: "" },
    },
    { new: true },
  );
  if (!subscription) return result;
  const allowances = (subscription.allowancesSnapshot ?? {}) as Record<string, unknown>;
  const includedCredits = Math.max(0, Number(allowances.includedCredits ?? 0));
  if (includedCredits > 0 && result.grantsAllowance !== false) {
    await recordCreditTopUp({
      orgId: String(subscription.orgId),
      amountCredits: includedCredits,
      paymentProvider: payment ? "razorpay" : "internal",
      idempotencyKey: `white-label-customer-invoice:${result.id}:allowance`,
      description: `${subscription.planKey} v${subscription.planVersion} included voice credits`,
    });
  }
  if (settled) {
    await PlatformAuditLogModel.create({
      actorType: "system",
      actorEmail: payment ? "razorpay-webhook@internal" : "system@internal",
      action: "white_label.customer_invoice_paid",
      resource: "white_label_customer_invoice",
      resourceId: result.id,
      accountId: result.accountId,
      targetOrgId: result.orgId,
      reason: payment
        ? `Verified Razorpay payment ${payment.id} for ${result.invoiceNumber}.`
        : `Zero-value invoice ${result.invoiceNumber} settled internally.`,
      before: { status: invoice.status },
      after: { status: "paid", paymentId: payment?.id ?? "internal", paidAt },
    });
  }
  return result;
}

export async function reconcileWhiteLabelCustomerTransfer(transfer: WhiteLabelCustomerRazorpayTransfer) {
  if (!transfer.id || !transfer.source) return null;
  return WhiteLabelCustomerInvoiceModel.findOneAndUpdate(
    {
      $or: [{ razorpayOrderId: transfer.source }, { razorpayPaymentId: transfer.source }],
      transferMode: "full_amount",
      ...(transfer.recipient ? { razorpayLinkedAccountId: transfer.recipient } : {}),
    },
    {
      $set: {
        razorpayTransferId: transfer.id,
        transferStatus: transfer.status ?? "pending",
        ...(transfer.status === "failed" ? { failureMessage: "Razorpay Route transfer failed." } : {}),
      },
    },
    { new: true },
  );
}

export async function reconcileWhiteLabelCustomerRefund(
  refund: WhiteLabelCustomerRazorpayRefund,
  payment: WhiteLabelCustomerRazorpayPayment | null,
) {
  if (!refund.id || !refund.payment_id || refund.status !== "processed") return null;
  const invoice = await WhiteLabelCustomerInvoiceModel.findOne({ razorpayPaymentId: refund.payment_id });
  if (!invoice) return null;
  if (refund.currency && refund.currency.toUpperCase() !== invoice.currency) {
    throw new HttpError(409, "Razorpay refund currency does not match the retail invoice.");
  }
  const cumulativeRefundedMinor = calculateWhiteLabelCustomerRefundTotal({
    totalMinor: invoice.totalMinor,
    refundedMinor: invoice.refundedMinor,
    lastRefundId: invoice.lastRefundId,
    refundId: refund.id,
    refundAmount: refund.amount,
    providerCumulativeRefund: payment?.amount_refunded,
  });
  const fullRefund = cumulativeRefundedMinor >= invoice.totalMinor;
  const updated = await WhiteLabelCustomerInvoiceModel.findByIdAndUpdate(
    invoice._id,
    {
      $set: {
        refundedMinor: cumulativeRefundedMinor,
        refundStatus: fullRefund ? "full" : "partial",
        lastRefundId: refund.id,
        ...(fullRefund ? { status: "refunded" } : {}),
      },
    },
    { new: true, runValidators: true },
  );
  if (!updated) return null;
  let paused = false;
  if (fullRefund) {
    const subscription = await WhiteLabelSubscriptionModel.findOneAndUpdate(
      {
        _id: invoice.subscriptionId,
        lastPaymentInvoiceId: invoice._id,
        status: { $nin: ["cancelled", "expired"] },
      },
      { $set: { status: "paused", billingSuspendedAt: new Date() } },
      { new: true },
    );
    paused = Boolean(subscription);
    await notifyWhiteLabelCustomerBilling(invoice.id, "refunded").catch(() => undefined);
    if (subscription) await ensureWhiteLabelCustomerInvoice(String(invoice.orgId));
  }
  await PlatformAuditLogModel.create({
    actorType: "system",
    actorEmail: "razorpay-webhook@internal",
    action: fullRefund ? "white_label.customer_invoice_refunded" : "white_label.customer_invoice_partially_refunded",
    resource: "white_label_customer_invoice",
    resourceId: invoice.id,
    accountId: invoice.accountId,
    targetOrgId: invoice.orgId,
    reason: `Verified Razorpay refund ${refund.id} for payment ${refund.payment_id}.`,
    before: { status: invoice.status, refundedMinor: invoice.refundedMinor },
    after: { status: updated.status, refundedMinor: updated.refundedMinor, subscriptionPaused: paused },
  });
  return updated;
}

export async function reconcileWhiteLabelCustomerDispute(
  dispute: WhiteLabelCustomerRazorpayDispute,
  status: "created" | "under_review" | "action_required" | "won" | "lost" | "closed",
) {
  if (!dispute.id || !dispute.payment_id) return null;
  const invoice = await WhiteLabelCustomerInvoiceModel.findOne({ razorpayPaymentId: dispute.payment_id });
  if (!invoice) return null;
  if (dispute.currency && dispute.currency.toUpperCase() !== invoice.currency) {
    throw new HttpError(409, "Razorpay dispute currency does not match the retail invoice.");
  }
  const now = new Date();
  const terminalStatus = status === "won" ? "paid" : status === "lost" ? "refunded" : null;
  const updated = await WhiteLabelCustomerInvoiceModel.findByIdAndUpdate(
    invoice._id,
    {
      $set: {
        disputeId: dispute.id,
        disputeStatus: status,
        disputeReason: String(dispute.reason_code ?? "").slice(0, 1_000),
        disputedAt: invoice.disputedAt ?? now,
        ...(terminalStatus ? { status: terminalStatus } : status === "closed" ? {} : { status: "disputed" }),
        ...(status === "lost" ? { refundStatus: "full", refundedMinor: invoice.totalMinor } : {}),
      },
    },
    { new: true, runValidators: true },
  );
  if (!updated) return null;
  if (status === "won") {
    await WhiteLabelSubscriptionModel.updateOne(
      {
        _id: invoice.subscriptionId,
        lastPaymentInvoiceId: invoice._id,
        status: "paused",
      },
      {
        $set: { status: "active" },
        $unset: { billingSuspendedAt: "", pastDueAt: "", graceEndsAt: "" },
      },
    );
    await notifyWhiteLabelCustomerBilling(invoice.id, "dispute_won").catch(() => undefined);
  } else if (status !== "closed") {
    const subscription = await WhiteLabelSubscriptionModel.findOneAndUpdate(
      {
        _id: invoice.subscriptionId,
        lastPaymentInvoiceId: invoice._id,
        status: { $nin: ["cancelled", "expired"] },
      },
      { $set: { status: "paused", billingSuspendedAt: now } },
      { new: true },
    );
    if (status === "created") {
      await notifyWhiteLabelCustomerBilling(invoice.id, "disputed").catch(() => undefined);
    }
    if (status === "lost" && subscription) {
      await notifyWhiteLabelCustomerBilling(invoice.id, "refunded").catch(() => undefined);
      await ensureWhiteLabelCustomerInvoice(String(invoice.orgId));
    }
  }
  await PlatformAuditLogModel.create({
    actorType: "system",
    actorEmail: "razorpay-webhook@internal",
    action: `white_label.customer_invoice_dispute_${status}`,
    resource: "white_label_customer_invoice",
    resourceId: invoice.id,
    accountId: invoice.accountId,
    targetOrgId: invoice.orgId,
    reason: `Verified Razorpay dispute ${dispute.id} changed to ${status}.`,
    before: { status: invoice.status, disputeStatus: invoice.disputeStatus },
    after: { status: updated.status, disputeStatus: updated.disputeStatus },
  });
  return updated;
}

export async function markWhiteLabelCustomerPaymentFailed(orderId: string, paymentId: string, message: string) {
  const invoice = await WhiteLabelCustomerInvoiceModel.findOneAndUpdate(
    { razorpayOrderId: orderId, status: { $in: ["open", "past_due"] } },
    { $set: { failureMessage: message.slice(0, 1_000) || `Payment ${paymentId} failed.` } },
    { new: true },
  );
  if (!invoice) return null;
  const account = await WhiteLabelAccountModel.findById(invoice.accountId).select("retailBilling.gracePeriodDays").lean();
  const now = new Date();
  const graceDays = Math.max(0, Number(account?.retailBilling?.gracePeriodDays ?? 3));
  if (invoice.dueAt <= now) {
    await WhiteLabelSubscriptionModel.updateOne(
      { _id: invoice.subscriptionId, status: { $in: ["incomplete", "trialing", "active"] } },
      {
        $set: {
          status: "past_due",
          pastDueAt: now,
          graceEndsAt: new Date(now.getTime() + graceDays * 24 * 60 * 60_000),
        },
      },
    );
  }
  await notifyWhiteLabelCustomerBilling(invoice.id, "payment_failed").catch(() => undefined);
  return invoice;
}

export async function whiteLabelCustomerBillingSummary(orgId: string) {
  const current = await ensureWhiteLabelCustomerInvoice(orgId);
  const invoices = await WhiteLabelCustomerInvoiceModel.find({ orgId }).sort({ createdAt: -1 }).limit(24);
  return { ...current, invoices };
}

export async function processWhiteLabelCustomerBilling(limit = 100) {
  if (!env.whiteLabelEnabled) return { pastDue: 0, paused: 0 };
  const now = new Date();
  const subscriptions = await WhiteLabelSubscriptionModel.find({
    $or: [
      { status: "incomplete" },
      {
        status: { $in: ["trialing", "active", "past_due"] },
        $or: [
          { currentPeriodEnd: { $lte: now } },
          { trialEndsAt: { $lte: now } },
          { graceEndsAt: { $lte: now } },
        ],
      },
    ],
  }).limit(Math.min(500, Math.max(1, limit)));
  let pastDue = 0;
  let paused = 0;
  for (const subscription of subscriptions) {
    const account = await WhiteLabelAccountModel.findOne({
      _id: subscription.accountId,
      "retailBilling.enabled": true,
    }).select("retailBilling.gracePeriodDays");
    if (!account) continue;
    if (subscription.status === "incomplete") {
      await ensureWhiteLabelCustomerInvoice(String(subscription.orgId), now);
      continue;
    }
    if (subscription.status === "past_due" && subscription.graceEndsAt && subscription.graceEndsAt <= now) {
      const updated = await WhiteLabelSubscriptionModel.findOneAndUpdate(
        { _id: subscription._id, status: "past_due", graceEndsAt: { $lte: now } },
        { $set: { status: "paused", billingSuspendedAt: now } },
        { new: true },
      );
      if (updated) {
        const invoice = await WhiteLabelCustomerInvoiceModel.findOne({
          subscriptionId: subscription._id,
          status: "past_due",
        }).sort({ dueAt: -1 });
        if (invoice) await notifyWhiteLabelCustomerBillingOnce(invoice.id, "paused").catch(() => undefined);
        paused += 1;
      }
      continue;
    }
    await ensureWhiteLabelCustomerInvoice(String(subscription.orgId), now);
    const graceDays = Math.max(0, Number(account.retailBilling?.gracePeriodDays ?? 3));
    const graceEndsAt = new Date(now.getTime() + graceDays * 24 * 60 * 60_000);
    const updated = await WhiteLabelSubscriptionModel.findOneAndUpdate(
      { _id: subscription._id, status: { $in: ["trialing", "active"] } },
      { $set: { status: "past_due", pastDueAt: now, graceEndsAt } },
      { new: true },
    );
    if (updated) {
      const invoice = await WhiteLabelCustomerInvoiceModel.findOneAndUpdate(
        { subscriptionId: subscription._id, status: "open", dueAt: { $lte: now } },
        { $set: { status: "past_due" } },
        { new: true },
      );
      if (invoice) await notifyWhiteLabelCustomerBillingOnce(invoice.id, "past_due").catch(() => undefined);
      pastDue += 1;
    }
  }
  return { pastDue, paused };
}
