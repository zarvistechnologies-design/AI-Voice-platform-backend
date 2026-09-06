import { env } from "../config/env.js";
import { BillingTransactionModel } from "../models/BillingTransaction.js";
import { OrganizationModel } from "../models/Organization.js";
import { PlatformAuditLogModel } from "../models/PlatformAuditLog.js";
import { WhiteLabelAccountModel } from "../models/WhiteLabelAccount.js";
import { WhiteLabelPartnerInvoiceModel } from "../models/WhiteLabelPartnerInvoice.js";
import { razorpayRequest } from "./razorpayService.js";
import { HttpError } from "../utils/httpError.js";

export type WhiteLabelPartnerRazorpayOrder = {
  id: string;
  amount: number;
  amount_paid: number;
  currency: string;
  status: "created" | "attempted" | "paid";
  notes?: Record<string, string>;
};

export type WhiteLabelPartnerRazorpayPayment = {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  method?: string;
};

type InvoiceCalculationInput = {
  platformFeeMinor: number;
  minimumCommitmentMinor: number;
  usageWholesaleMinor: number;
  includedCreditMinor: number;
  wholesaleMarkupBps: number;
};

type PartnerBillingAccount = {
  id?: string;
  _id: unknown;
  ownerOrgId: unknown;
  slug: string;
  contract?: {
    currency?: string;
    billingInterval?: "month" | "year";
    platformFeeMinor?: number;
    minimumCommitmentMinor?: number;
    includedCredits?: number;
    wholesaleMarkupBps?: number;
    paymentTermsDays?: number;
    effectiveAt?: Date;
  } | null;
};

function nonNegativeInteger(value: number) {
  return Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
}

export function calculateWhiteLabelPartnerInvoice(input: InvoiceCalculationInput) {
  const platformFeeMinor = nonNegativeInteger(input.platformFeeMinor);
  const minimumCommitmentMinor = nonNegativeInteger(input.minimumCommitmentMinor);
  const usageWholesaleMinor = nonNegativeInteger(input.usageWholesaleMinor);
  const includedCreditDiscountMinor = Math.min(
    usageWholesaleMinor,
    nonNegativeInteger(input.includedCreditMinor),
  );
  const billableWholesaleMinor = usageWholesaleMinor - includedCreditDiscountMinor;
  const markupBps = Math.max(0, Math.min(100_000, nonNegativeInteger(input.wholesaleMarkupBps)));
  const usageMarkupMinor = Math.round(billableWholesaleMinor * markupBps / 10_000);
  const meteredUsageMinor = billableWholesaleMinor + usageMarkupMinor;
  const committedUsageMinor = Math.max(minimumCommitmentMinor, meteredUsageMinor);
  return {
    platformFeeMinor,
    minimumCommitmentMinor,
    usageWholesaleMinor,
    includedCreditDiscountMinor,
    usageMarkupMinor,
    committedUsageMinor,
    totalMinor: platformFeeMinor + committedUsageMinor,
  };
}

export function whiteLabelContractPeriod(at: Date, interval: "month" | "year") {
  const year = at.getUTCFullYear();
  const month = interval === "year" ? 0 : at.getUTCMonth();
  const periodStart = new Date(Date.UTC(year, month, 1));
  const periodEnd = interval === "year"
    ? new Date(Date.UTC(year + 1, 0, 1))
    : new Date(Date.UTC(year, month + 1, 1));
  return { periodStart, periodEnd };
}

function contractCurrency(account: { contract?: { currency?: string } | null }) {
  return account.contract?.currency === "INR" ? "INR" as const : "USD" as const;
}

function includedCreditMinor(account: { contract?: { includedCredits?: number; currency?: string } | null }) {
  const credits = Math.max(0, Number(account.contract?.includedCredits ?? 0));
  const major = contractCurrency(account) === "INR" ? credits * env.costRates.inrPerUsd : credits;
  return Math.round(major * 100);
}

async function unbilledWholesaleMinor(
  accountId: string,
  usageStart: Date,
  usageEnd: Date,
  currency: "USD" | "INR",
) {
  const organizations = await OrganizationModel.find({ whiteLabelAccountId: accountId })
    .select("_id")
    .lean();
  const orgIds = organizations.map((organization) => String(organization._id));
  if (!orgIds.length) return 0;
  type WholesaleSnapshot = {
    callId: string;
    wholesaleCost: number;
    billingCurrency: string;
    fxRate: number;
  };
  const snapshotsAt = (cutoff: Date) => BillingTransactionModel.aggregate<WholesaleSnapshot>([
      {
        $match: {
          orgId: { $in: orgIds },
          category: "call",
          createdAt: { $lt: cutoff },
        },
      },
      { $sort: { createdAt: 1 } },
      { $group: { _id: "$callId", latest: { $last: "$$ROOT" } } },
      {
        $project: {
          _id: 0,
          callId: "$_id",
          wholesaleCost: { $ifNull: ["$latest.breakdown.wholesaleCost", 0] },
          billingCurrency: { $ifNull: ["$latest.breakdown.billingCurrency", "$latest.currency"] },
          fxRate: { $ifNull: ["$latest.breakdown.fxRate", 1] },
        },
      },
    ]);
  const [before, after] = await Promise.all([snapshotsAt(usageStart), snapshotsAt(usageEnd)]);
  const asUsd = (row: WholesaleSnapshot) => {
    const cost = Math.max(0, Number(row.wholesaleCost) || 0);
    const fx = Math.max(0.000001, Number(row.fxRate) || env.costRates.inrPerUsd || 1);
    return String(row.billingCurrency).toUpperCase() === "INR" ? cost / fx : cost;
  };
  const beforeByCall = new Map(before.map((row) => [row.callId, asUsd(row)]));
  const usd = Math.max(0, after.reduce(
    (total, row) => total + asUsd(row) - (beforeByCall.get(row.callId) ?? 0),
    0,
  ));
  return Math.round((currency === "INR" ? usd * env.costRates.inrPerUsd : usd) * 100);
}

function invoiceNumber(accountSlug: string, accountId: string, periodStart: Date) {
  const period = periodStart.toISOString().slice(0, 7).replace("-", "");
  const slug = accountSlug.replace(/[^a-z0-9]/gi, "").slice(0, 12).toUpperCase() || "PARTNER";
  const suffix = accountId.replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase();
  return `WL-${period}-${slug}-${suffix}`;
}

export async function ensureWhiteLabelPartnerInvoice(
  account: PartnerBillingAccount,
  now = new Date(),
) {
  const accountId = String(account._id);
  const interval = account.contract?.billingInterval === "year" ? "year" : "month";
  const { periodStart, periodEnd } = whiteLabelContractPeriod(now, interval);
  const existing = await WhiteLabelPartnerInvoiceModel.findOne({
    accountId: account._id,
    periodStart,
  });
  if (existing) return existing;

  const previous = await WhiteLabelPartnerInvoiceModel.findOne({ accountId: account._id })
    .sort({ usageEnd: -1 })
    .select("usageEnd")
    .lean();
  const effectiveAt = account.contract?.effectiveAt
    ? new Date(account.contract.effectiveAt)
    : periodStart;
  const usageStart = previous?.usageEnd && previous.usageEnd > effectiveAt
    ? previous.usageEnd
    : effectiveAt;
  const usageEnd = now;
  const currency = contractCurrency(account);
  const usageWholesaleMinor = await unbilledWholesaleMinor(
    accountId,
    usageStart,
    usageEnd,
    currency,
  );
  const calculation = calculateWhiteLabelPartnerInvoice({
    platformFeeMinor: Number(account.contract?.platformFeeMinor ?? 0),
    minimumCommitmentMinor: Number(account.contract?.minimumCommitmentMinor ?? 0),
    usageWholesaleMinor,
    includedCreditMinor: includedCreditMinor(account),
    wholesaleMarkupBps: Number(account.contract?.wholesaleMarkupBps ?? 0),
  });
  const paymentTermsDays = Math.max(0, Number(account.contract?.paymentTermsDays ?? 0));
  const dueAt = new Date(now.getTime() + paymentTermsDays * 24 * 60 * 60_000);
  try {
    const invoice = await WhiteLabelPartnerInvoiceModel.create({
      accountId: account._id,
      ownerOrgId: account.ownerOrgId,
      invoiceNumber: invoiceNumber(account.slug, accountId, periodStart),
      status: calculation.totalMinor === 0 ? "paid" : "open",
      provider: calculation.totalMinor === 0 ? "internal" : "razorpay",
      currency,
      periodStart,
      periodEnd,
      usageStart,
      usageEnd,
      dueAt,
      ...calculation,
      ...(calculation.totalMinor === 0 ? { paidAt: now } : {}),
    });
    if (calculation.totalMinor === 0) {
      await WhiteLabelAccountModel.updateOne(
        { _id: account._id, billingStatus: { $in: ["active", "past_due", "suspended"] } },
        { $set: { billingStatus: "active" } },
      );
    }
    return invoice;
  } catch (error) {
    const duplicate = await WhiteLabelPartnerInvoiceModel.findOne({
      accountId: account._id,
      periodStart,
    });
    if (duplicate) return duplicate;
    throw error;
  }
}

export async function whiteLabelPartnerBillingSummary(accountId: string) {
  const account = await WhiteLabelAccountModel.findById(accountId);
  if (!account) throw new HttpError(404, "White-label account not found.");
  const invoice = await ensureWhiteLabelPartnerInvoice(account);
  const invoices = await WhiteLabelPartnerInvoiceModel.find({ accountId: account._id })
    .sort({ createdAt: -1 })
    .limit(24)
    .lean();
  return { invoice, invoices };
}

export async function settleWhiteLabelPartnerOrder(
  order: WhiteLabelPartnerRazorpayOrder,
  payment: WhiteLabelPartnerRazorpayPayment,
) {
  const invoiceId = String(order.notes?.whiteLabelInvoiceId ?? "");
  const accountId = String(order.notes?.whiteLabelAccountId ?? "");
  if (order.notes?.kind !== "white_label_partner_invoice" || !invoiceId || !accountId) {
    throw new HttpError(400, "Razorpay order is not a white-label partner invoice.");
  }
  const invoice = await WhiteLabelPartnerInvoiceModel.findOne({ _id: invoiceId, accountId });
  if (!invoice) throw new HttpError(404, "White-label partner invoice not found.");
  if (invoice.status === "paid") {
    if (invoice.razorpayPaymentId && invoice.razorpayPaymentId !== payment.id) {
      throw new HttpError(409, "Invoice was already settled by another payment.");
    }
    return invoice;
  }
  if (
    payment.status !== "captured"
    || payment.order_id !== order.id
    || order.status !== "paid"
    || order.amount !== invoice.totalMinor
    || payment.amount !== invoice.totalMinor
    || order.currency.toUpperCase() !== invoice.currency
    || payment.currency.toUpperCase() !== invoice.currency
    || (invoice.razorpayOrderId && invoice.razorpayOrderId !== order.id)
  ) {
    throw new HttpError(409, "Razorpay payment does not match the white-label invoice.");
  }
  const paidAt = new Date();
  const settled = await WhiteLabelPartnerInvoiceModel.findOneAndUpdate(
    { _id: invoice._id, status: { $ne: "paid" } },
    {
      $set: {
        status: "paid",
        provider: "razorpay",
        razorpayOrderId: order.id,
        razorpayPaymentId: payment.id,
        paymentMethod: payment.method ?? "",
        paidAt,
        failureMessage: "",
      },
    },
    { new: true, runValidators: true },
  );
  if (!settled) {
    const alreadySettled = await WhiteLabelPartnerInvoiceModel.findById(invoice._id);
    if (alreadySettled?.status === "paid") return alreadySettled;
    throw new HttpError(409, "White-label invoice settlement changed concurrently.");
  }
  await Promise.all([
    WhiteLabelAccountModel.updateOne(
      { _id: accountId, billingStatus: { $nin: ["cancelled"] } },
      { $set: { billingStatus: "active" } },
    ),
    PlatformAuditLogModel.create({
      actorType: "system",
      actorEmail: "razorpay-webhook@internal",
      action: "white_label.partner_invoice_paid",
      resource: "white_label_partner_invoice",
      resourceId: settled.id,
      accountId,
      targetOrgId: settled.ownerOrgId,
      reason: `Verified Razorpay payment ${payment.id} for ${settled.invoiceNumber}.`,
      before: { status: invoice.status },
      after: { status: "paid", paymentId: payment.id, paidAt },
    }),
  ]);
  return settled;
}

export async function processWhiteLabelPartnerBilling(limit = 100) {
  if (!env.whiteLabelEnabled) return { generated: 0, overdue: 0 };
  const accounts = await WhiteLabelAccountModel.find({
    status: { $in: ["onboarding", "active"] },
    billingStatus: { $in: ["active", "past_due", "suspended"] },
  }).limit(Math.min(500, Math.max(1, limit)));
  let generated = 0;
  for (const account of accounts) {
    await ensureWhiteLabelPartnerInvoice(account);
    generated += 1;
  }
  const now = new Date();
  const due = await WhiteLabelPartnerInvoiceModel.find({
    status: "open",
    dueAt: { $lt: now },
  }).select("_id accountId invoiceNumber").limit(Math.min(500, Math.max(1, limit))).lean();
  let overdue = 0;
  for (const invoice of due) {
    const updated = await WhiteLabelPartnerInvoiceModel.findOneAndUpdate(
      { _id: invoice._id, status: "open", dueAt: { $lt: now } },
      { $set: { status: "past_due" } },
      { new: true },
    );
    if (!updated) continue;
    const account = await WhiteLabelAccountModel.findById(invoice.accountId)
      .select("billingStatus contract.autoSuspendOnPastDue ownerOrgId")
      .lean();
    if (account && account.billingStatus !== "cancelled") {
      const billingStatus = account.contract?.autoSuspendOnPastDue ? "suspended" : "past_due";
      await WhiteLabelAccountModel.updateOne(
        { _id: invoice.accountId, billingStatus: { $ne: "cancelled" } },
        { $set: { billingStatus } },
      );
      await PlatformAuditLogModel.create({
        actorType: "system",
        actorEmail: "system@internal",
        action: "white_label.partner_invoice_past_due",
        resource: "white_label_partner_invoice",
        resourceId: updated.id,
        accountId: invoice.accountId,
        targetOrgId: account.ownerOrgId,
        reason: `${updated.invoiceNumber} passed its payment due date.`,
        before: { status: "open", billingStatus: account.billingStatus },
        after: { status: "past_due", billingStatus },
      });
    }
    overdue += 1;
  }
  return { generated, overdue };
}

export async function razorpayOrderForWhiteLabelInvoice(invoiceId: string, accountId: string) {
  const invoice = await WhiteLabelPartnerInvoiceModel.findOne({ _id: invoiceId, accountId });
  if (!invoice) throw new HttpError(404, "White-label partner invoice not found.");
  if (invoice.status === "paid") return { invoice, order: null };
  if (invoice.status === "void") throw new HttpError(409, "This invoice is void.");
  if (!invoice.razorpayOrderId) {
    const order = await razorpayRequest<WhiteLabelPartnerRazorpayOrder>("/orders", {
      method: "POST",
      body: {
        amount: invoice.totalMinor,
        currency: invoice.currency,
        receipt: invoice.invoiceNumber.slice(0, 40),
        notes: {
          kind: "white_label_partner_invoice",
          whiteLabelAccountId: String(invoice.accountId),
          whiteLabelInvoiceId: invoice.id,
          ownerOrgId: String(invoice.ownerOrgId),
          invoiceNumber: invoice.invoiceNumber,
        },
      },
    });
    const claimed = await WhiteLabelPartnerInvoiceModel.findOneAndUpdate(
      { _id: invoice._id, razorpayOrderId: { $in: [null, ""] }, status: { $ne: "paid" } },
      { $set: { razorpayOrderId: order.id, provider: "razorpay" } },
      { new: true },
    );
    if (!claimed) {
      const current = await WhiteLabelPartnerInvoiceModel.findById(invoice._id);
      if (current?.status === "paid") return { invoice: current, order: null };
      if (current?.razorpayOrderId && current.razorpayOrderId !== order.id) {
        return {
          invoice: current,
          order: await razorpayRequest<WhiteLabelPartnerRazorpayOrder>(
            `/orders/${encodeURIComponent(current.razorpayOrderId)}`,
          ),
        };
      }
      throw new HttpError(409, "Invoice checkout changed concurrently. Please retry.");
    }
    return { invoice: claimed, order };
  }
  const order = await razorpayRequest<WhiteLabelPartnerRazorpayOrder>(
    `/orders/${encodeURIComponent(invoice.razorpayOrderId)}`,
  );
  return { invoice, order };
}
