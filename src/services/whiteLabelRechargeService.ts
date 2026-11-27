import { createHmac, timingSafeEqual } from "node:crypto";
import { startSession, Types } from "mongoose";

import { BillingTransactionModel } from "../models/BillingTransaction.js";
import { CreditWalletModel } from "../models/CreditWallet.js";
import { PlatformAuditLogModel } from "../models/PlatformAuditLog.js";
import { WhiteLabelAccountModel } from "../models/WhiteLabelAccount.js";
import { WhiteLabelRechargeOrderModel } from "../models/WhiteLabelRechargeOrder.js";
import { WhiteLabelSubscriptionModel } from "../models/WhiteLabelSubscription.js";
import { recordCreditTopUp, ensureCreditWallet } from "./billingService.js";
import { razorpayRequest } from "./razorpayService.js";
import {
  calculateWhiteLabelCustomerRefundTotal,
  effectiveCustomerBillingMode,
  resolveAccountRazorpayCredentials,
  type WhiteLabelCustomerRazorpayDispute,
  type WhiteLabelCustomerRazorpayOrder,
  type WhiteLabelCustomerRazorpayPayment,
  type WhiteLabelCustomerRazorpayRefund,
} from "./whiteLabelCustomerBillingService.js";
import { HttpError } from "../utils/httpError.js";

export function assertRechargePaymentMatches(
  recharge: { id: string; orgId: unknown; accountId: unknown; amountMinor: number; currency: string; razorpayOrderId?: string | null; razorpayPaymentId?: string | null },
  order: WhiteLabelCustomerRazorpayOrder,
  payment: WhiteLabelCustomerRazorpayPayment,
) {
  if (order.notes?.kind !== "white_label_recharge"
    || order.notes.rechargeId !== recharge.id
    || order.notes.orgId !== String(recharge.orgId)
    || order.notes.whiteLabelAccountId !== String(recharge.accountId)
    || order.id !== recharge.razorpayOrderId
    || (recharge.razorpayPaymentId && recharge.razorpayPaymentId !== payment.id)
    || order.status !== "paid" || payment.status !== "captured"
    || payment.order_id !== order.id
    || order.amount !== recharge.amountMinor || payment.amount !== recharge.amountMinor
    || order.currency.toUpperCase() !== recharge.currency
    || payment.currency.toUpperCase() !== recharge.currency) {
    throw new HttpError(409, "Razorpay payment does not match this recharge.");
  }
}

export async function createWhiteLabelRecharge(orgId: string, packageId: string) {
  if (!Types.ObjectId.isValid(packageId)) throw new HttpError(400, "Select a valid recharge package.");
  const subscription = await WhiteLabelSubscriptionModel.findOne({ orgId }).lean();
  if (!subscription || !["active", "trialing"].includes(subscription.status)) {
    throw new HttpError(409, "An active customer subscription is required to recharge.");
  }
  const account = await WhiteLabelAccountModel.findById(subscription.accountId)
    .select("+retailBilling.customKeySecretEncrypted +retailBilling.customWebhookSecretEncrypted");
  if (!account || account.status !== "active") throw new HttpError(409, "Partner billing is not active.");
  if (effectiveCustomerBillingMode(account, subscription) === "manual") {
    throw new HttpError(403, "Online wallet recharge is disabled for this workspace. Contact your provider.");
  }
  if (account.retailBilling?.gatewayMode !== "custom") {
    throw new HttpError(409, "Your provider has not connected their Razorpay account.");
  }
  const rechargePackage = account.rechargePackages.id(packageId);
  if (!rechargePackage || !rechargePackage.active) throw new HttpError(404, "Recharge package is unavailable.");
  const wallet = await ensureCreditWallet(orgId);
  if (wallet.currency !== rechargePackage.currency) {
    throw new HttpError(409, `This package is for ${rechargePackage.currency} wallets. Your wallet uses ${wallet.currency}.`);
  }
  const credentials = resolveAccountRazorpayCredentials(account);
  const recharge = await WhiteLabelRechargeOrderModel.create({
    accountId: account._id, orgId, packageId: rechargePackage._id,
    packageName: rechargePackage.name, currency: rechargePackage.currency,
    amountMinor: rechargePackage.priceMinor, credits: rechargePackage.credits,
    taxRateBps: account.retailBilling.taxRateBps ?? 0,
  });
  let order: WhiteLabelCustomerRazorpayOrder;
  try {
    order = await razorpayRequest<WhiteLabelCustomerRazorpayOrder>("/orders", {
      method: "POST", credentials,
      body: {
        amount: recharge.amountMinor, currency: recharge.currency,
        receipt: `WLR-${recharge.id}`.slice(0, 40), partial_payment: false,
        notes: {
          kind: "white_label_recharge", rechargeId: recharge.id,
          orgId, whiteLabelAccountId: String(account._id),
        },
      },
    });
  } catch (error) {
    await WhiteLabelRechargeOrderModel.deleteOne({ _id: recharge._id, status: "pending" }).catch(() => undefined);
    throw error;
  }
  recharge.razorpayOrderId = order.id;
  await recharge.save();
  return { recharge, order, credentials, account };
}

export function verifyRechargeCheckoutSignature(orderId: string, paymentId: string, signature: string, secret: string) {
  const expected = createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  if (!signature || signature.length !== expected.length
    || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new HttpError(400, "Invalid Razorpay payment signature.");
  }
}

export async function settleWhiteLabelRecharge(order: WhiteLabelCustomerRazorpayOrder, payment: WhiteLabelCustomerRazorpayPayment) {
  const rechargeId = order.notes?.rechargeId ?? "";
  if (!Types.ObjectId.isValid(rechargeId)) throw new HttpError(400, "Invalid recharge order.");
  const recharge = await WhiteLabelRechargeOrderModel.findById(rechargeId);
  if (!recharge) throw new HttpError(404, "Recharge order not found.");
  assertRechargePaymentMatches({
    id: String(recharge._id),
    orgId: recharge.orgId,
    accountId: recharge.accountId,
    amountMinor: recharge.amountMinor,
    currency: recharge.currency,
    razorpayOrderId: recharge.razorpayOrderId,
    razorpayPaymentId: recharge.razorpayPaymentId,
  }, order, payment);
  if (recharge.status === "paid") return recharge;
  await recordCreditTopUp({
    orgId: String(recharge.orgId), amountCredits: recharge.credits,
    paymentProvider: "razorpay", razorpayOrderId: order.id,
    razorpayPaymentId: payment.id, expectedCurrency: recharge.currency,
    idempotencyKey: `white-label-recharge:${String(recharge._id)}`,
    description: `${recharge.packageName} recharge via ${payment.id}`,
  });
  const updated = await WhiteLabelRechargeOrderModel.findOneAndUpdate(
    { _id: recharge._id, status: "pending" },
    { $set: { status: "paid", razorpayPaymentId: payment.id, paidAt: new Date() } },
    { new: true },
  );
  return updated ?? await WhiteLabelRechargeOrderModel.findById(recharge._id) ?? recharge;
}

export async function verifyWhiteLabelRecharge(orgId: string, orderId: string, paymentId: string, signature: string) {
  const recharge = await WhiteLabelRechargeOrderModel.findOne({ orgId, razorpayOrderId: orderId });
  if (!recharge) throw new HttpError(404, "Recharge order not found.");
  const account = await WhiteLabelAccountModel.findById(recharge.accountId)
    .select("+retailBilling.customKeySecretEncrypted +retailBilling.customWebhookSecretEncrypted");
  if (!account || account.retailBilling?.gatewayMode !== "custom") throw new HttpError(409, "Partner gateway is unavailable.");
  const credentials = resolveAccountRazorpayCredentials(account);
  verifyRechargeCheckoutSignature(orderId, paymentId, signature, credentials.keySecret);
  const [order, payment] = await Promise.all([
    razorpayRequest<WhiteLabelCustomerRazorpayOrder>(`/orders/${encodeURIComponent(orderId)}`, { credentials }),
    razorpayRequest<WhiteLabelCustomerRazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`, { credentials }),
  ]);
  return settleWhiteLabelRecharge(order, payment);
}

export async function whiteLabelRechargeSummary(orgId: string) {
  const subscription = await WhiteLabelSubscriptionModel.findOne({ orgId }).lean();
  if (!subscription) {
    return { enabled: false, packages: [], orders: [], ready: false, currency: "INR", taxRateBps: 0, taxLabel: "GST", reason: "No customer subscription found." };
  }
  const account = await WhiteLabelAccountModel.findById(subscription.accountId)
    .select("+retailBilling.customKeySecretEncrypted +retailBilling.customWebhookSecretEncrypted");
  const wallet = await CreditWalletModel.findOne({ orgId }).lean();
  const currency = String(
    wallet?.currency
    ?? (subscription.priceSnapshot as Record<string, unknown> | undefined)?.currency
    ?? "INR",
  ).toUpperCase();
  const effectiveMode = effectiveCustomerBillingMode(account, subscription);
  const enabled = effectiveMode !== "manual";
  const packages = enabled
    ? (account?.rechargePackages ?? [])
      .filter((item) => item.active && item.currency === currency)
      .sort((left, right) => left.priceMinor - right.priceMinor)
      .map((item) => ({
        id: String(item._id),
        name: item.name,
        currency: item.currency,
        priceMinor: item.priceMinor,
        credits: item.credits,
      }))
    : [];
  const orders = await WhiteLabelRechargeOrderModel.find({ orgId, status: "paid" })
    .sort({ paidAt: -1, createdAt: -1 })
    .limit(20)
    .lean();
  let ready = false;
  let reason = "";
  if (!enabled) {
    reason = "Billing for this workspace is managed directly by your provider.";
  } else if (!account || account.status !== "active") {
    reason = "Provider account is not active yet.";
  } else if (!["active", "trialing"].includes(subscription.status)) {
    reason = "An active subscription is required before recharging.";
  } else if (account.retailBilling?.gatewayMode !== "custom") {
    reason = "Your provider has not connected their Razorpay gateway yet.";
  } else {
    try {
      const credentials = resolveAccountRazorpayCredentials(account);
      ready = Boolean(credentials.keyId && credentials.keySecret);
      if (!ready) reason = "Provider Razorpay credentials are incomplete.";
    } catch (error) {
      ready = false;
      reason = error instanceof Error ? error.message : "Provider Razorpay credentials are unavailable.";
    }
  }
  return {
    enabled,
    packages,
    orders,
    ready,
    currency,
    taxRateBps: account?.retailBilling?.taxRateBps ?? 0,
    taxLabel: account?.retailBilling?.taxLabel || "GST",
    reason,
  };
}

function roundedCredits(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function calculateWhiteLabelRechargeRefund(input: {
  amountMinor: number;
  credits: number;
  refundedMinor?: number;
  refundedCredits?: number;
  lastRefundId?: string;
  refundId: string;
  refundAmount?: number;
  providerCumulativeRefund?: number;
}) {
  const nextRefundedMinor = calculateWhiteLabelCustomerRefundTotal({
    totalMinor: input.amountMinor,
    refundedMinor: Math.max(0, Number(input.refundedMinor ?? 0)),
    lastRefundId: input.lastRefundId ?? "",
    refundId: input.refundId,
    refundAmount: Math.max(0, Number(input.refundAmount ?? 0)),
    providerCumulativeRefund: input.providerCumulativeRefund,
  });
  const targetRefundedCredits = nextRefundedMinor >= input.amountMinor
    ? roundedCredits(input.credits)
    : roundedCredits(input.credits * (nextRefundedMinor / Math.max(1, input.amountMinor)));
  const alreadyRefundedCredits = roundedCredits(Math.max(0, Number(input.refundedCredits ?? 0)));
  const deltaCredits = roundedCredits(Math.max(0, targetRefundedCredits - alreadyRefundedCredits));
  return {
    nextRefundedMinor,
    targetRefundedCredits,
    deltaCredits,
    fullRefund: nextRefundedMinor >= input.amountMinor,
  };
}

export async function reconcileWhiteLabelRechargeRefund(
  refund: WhiteLabelCustomerRazorpayRefund,
  payment: WhiteLabelCustomerRazorpayPayment | null,
  scopedAccountId?: string,
) {
  if (!refund.id || !refund.payment_id || refund.status !== "processed") return null;
  const recharge = await WhiteLabelRechargeOrderModel.findOne({
    razorpayPaymentId: refund.payment_id,
    ...(scopedAccountId ? { accountId: scopedAccountId } : {}),
  });
  if (!recharge) return null;
  if (refund.currency && refund.currency.toUpperCase() !== recharge.currency) {
    throw new HttpError(409, "Razorpay refund currency does not match the recharge order.");
  }
  const { nextRefundedMinor, targetRefundedCredits, deltaCredits, fullRefund } = calculateWhiteLabelRechargeRefund({
    amountMinor: recharge.amountMinor,
    credits: recharge.credits,
    refundedMinor: recharge.refundedMinor,
    refundedCredits: recharge.refundedCredits,
    lastRefundId: recharge.lastRefundId,
    refundId: refund.id,
    refundAmount: refund.amount,
    providerCumulativeRefund: payment?.amount_refunded,
  });
  const orgId = String(recharge.orgId);
  const claimKey = `wl-recharge-refund:${recharge.id}:${refund.id}`;
  await ensureCreditWallet(orgId);
  const session = await startSession();
  try {
    await session.withTransaction(async () => {
      if (deltaCredits > 0) {
        const existingTx = await BillingTransactionModel.findOne({ paymentClaimKey: claimKey })
          .select("_id")
          .session(session);
        if (!existingTx) {
          const wallet = await CreditWalletModel.findOneAndUpdate(
            { orgId },
            { $inc: { balanceCredits: -deltaCredits }, $set: { lastCheckedAt: new Date() } },
            { new: true, runValidators: true, session },
          );
          await BillingTransactionModel.create([{
            orgId,
            type: "refund",
            category: "payment",
            amountCredits: -deltaCredits,
            currency: wallet?.currency || recharge.currency,
            balanceAfterCredits: wallet?.balanceCredits ?? 0,
            description: `Refund (${refund.id}) for ${recharge.packageName} recharge`,
            paymentProvider: "razorpay",
            razorpayOrderId: recharge.razorpayOrderId,
            razorpayPaymentId: refund.payment_id,
            paymentClaimKey: claimKey,
          }], { session });
        }
      }
      await WhiteLabelRechargeOrderModel.updateOne(
        { _id: recharge._id },
        {
          $set: {
            refundedMinor: nextRefundedMinor,
            refundedCredits: targetRefundedCredits,
            lastRefundId: refund.id,
            refundedAt: recharge.refundedAt ?? new Date(),
            ...(fullRefund ? { status: "refunded" } : {}),
          },
        },
        { session },
      );
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } finally {
    await session.endSession();
  }
  await PlatformAuditLogModel.create({
    actorType: "system",
    actorEmail: "razorpay-webhook@internal",
    action: fullRefund ? "white_label.recharge_refunded" : "white_label.recharge_partially_refunded",
    resource: "white_label_recharge_order",
    resourceId: recharge.id,
    accountId: recharge.accountId,
    targetOrgId: recharge.orgId,
    reason: `Verified Razorpay refund ${refund.id} for recharge payment ${refund.payment_id}.`,
    before: { status: recharge.status, refundedMinor: recharge.refundedMinor, refundedCredits: recharge.refundedCredits },
    after: { refundedMinor: nextRefundedMinor, refundedCredits: targetRefundedCredits, debitedCredits: deltaCredits },
  });
  return WhiteLabelRechargeOrderModel.findById(recharge._id);
}

export async function reconcileWhiteLabelRechargeDispute(
  dispute: WhiteLabelCustomerRazorpayDispute,
  status: "created" | "under_review" | "action_required" | "won" | "lost" | "closed",
  scopedAccountId?: string,
) {
  if (!dispute.id || !dispute.payment_id) return null;
  const recharge = await WhiteLabelRechargeOrderModel.findOne({
    razorpayPaymentId: dispute.payment_id,
    ...(scopedAccountId ? { accountId: scopedAccountId } : {}),
  });
  if (!recharge) return null;
  if (dispute.currency && dispute.currency.toUpperCase() !== recharge.currency) {
    throw new HttpError(409, "Razorpay dispute currency does not match the recharge order.");
  }
  const nextStatus = status === "won" ? "paid" : status === "lost" ? "refunded" : status === "closed" ? recharge.status : "disputed";
  const updated = await WhiteLabelRechargeOrderModel.findByIdAndUpdate(
    recharge._id,
    { $set: { disputeId: dispute.id, disputeStatus: status, status: nextStatus } },
    { new: true, runValidators: true },
  );
  await PlatformAuditLogModel.create({
    actorType: "system",
    actorEmail: "razorpay-webhook@internal",
    action: `white_label.recharge_dispute_${status}`,
    resource: "white_label_recharge_order",
    resourceId: recharge.id,
    accountId: recharge.accountId,
    targetOrgId: recharge.orgId,
    reason: `Razorpay dispute ${dispute.id} entered ${status}.`,
    before: { status: recharge.status, disputeStatus: recharge.disputeStatus },
    after: { status: nextStatus, disputeStatus: status },
  });
  return updated;
}
