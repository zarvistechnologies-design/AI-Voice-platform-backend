import { startSession, type HydratedDocument } from "mongoose";

import { env } from "../config/env.js";
import { BillingSubscriptionModel } from "../models/BillingSubscription.js";
import {
  BillingTransactionModel,
  type BillingTransaction,
} from "../models/BillingTransaction.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { CreditWalletModel } from "../models/CreditWallet.js";
import { OrganizationMemberModel } from "../models/OrganizationMember.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { HttpError } from "../utils/httpError.js";

export const planCatalog = {
  free: {
    id: "free",
    name: "Pay as you go",
    monthlyPrice: 0,
    limits: { agents: null, members: null, phoneNumbers: null, monthlyMinutes: null },
  },
} as const;

function positiveNumber(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function roundedCredits(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function callChargeAdjustment(targetCharge: number, ledgerAmounts: number[]) {
  const netCharged = roundedCredits(Math.max(
    0,
    -ledgerAmounts.reduce((sum, amount) => sum + amount, 0),
  ));
  return {
    netCharged,
    delta: roundedCredits(Math.max(0, targetCharge) - netCharged),
  };
}

function isDuplicateKeyError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === 11000);
}

export const creditBillingSettings = {
  currency: "USD",
  initialCredits: positiveNumber(env.billing.initialCredits, 5),
  minimumCallStartCredits: positiveNumber(env.billing.minimumCallStartCredits, 0.05),
  markupMultiplier: 1,
  platformFeeInrPerMinute: positiveNumber(env.costRates.platformFeeInrPerMinute, 2),
};

export async function ensureBillingSubscription(orgId: string) {
  return BillingSubscriptionModel.findOneAndUpdate(
    { orgId },
    { $setOnInsert: { orgId, plan: "free", status: "active", provider: "internal" } },
    { new: true, upsert: true, runValidators: true },
  );
}

export async function ensureCreditWallet(orgId: string) {
  const wallet = await CreditWalletModel.findOneAndUpdate(
    { orgId },
    {
      $setOnInsert: {
        orgId,
        balanceCredits: creditBillingSettings.initialCredits,
        lifetimePurchasedCredits: creditBillingSettings.initialCredits,
        currency: creditBillingSettings.currency,
      },
      $set: { lastCheckedAt: new Date() },
    },
    { new: true, upsert: true, runValidators: true },
  );

  if (
    creditBillingSettings.initialCredits > 0 &&
    wallet.balanceCredits === 0 &&
    wallet.lifetimePurchasedCredits === 0
  ) {
    const upgradedWallet = await CreditWalletModel.findOneAndUpdate(
      { orgId, balanceCredits: 0, lifetimePurchasedCredits: 0 },
      {
        $set: {
          balanceCredits: creditBillingSettings.initialCredits,
          lifetimePurchasedCredits: creditBillingSettings.initialCredits,
          currency: creditBillingSettings.currency,
          paymentProvider: "internal",
          lastPaymentStatus: "success",
          lastPaymentAmountCredits: creditBillingSettings.initialCredits,
          lastPaymentAt: new Date(),
          lastCheckedAt: new Date(),
        },
      },
      { new: true, runValidators: true },
    );
    return upgradedWallet ?? wallet;
  }

  return wallet;
}

function monthStart() {
  const date = new Date();
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export async function billingUsage(orgId: string) {
  const [agents, members, phoneNumbers, callUsage, creditUsage] = await Promise.all([
    VoiceAgentModel.countDocuments({ ownerId: orgId }),
    OrganizationMemberModel.countDocuments({ orgId }),
    PhoneNumberModel.countDocuments({ ownerId: orgId }),
    CallDetailRecordModel.aggregate([
      { $match: { ownerId: orgId, createdAt: { $gte: monthStart() } } },
      {
        $group: {
          _id: null,
          calls: { $sum: 1 },
          seconds: { $sum: "$durationSeconds" },
          providerCost: {
            $sum: {
              $add: [
                { $ifNull: ["$costBreakdown.llm", 0] },
                { $ifNull: ["$costBreakdown.stt", 0] },
                { $ifNull: ["$costBreakdown.tts", 0] },
              ],
            },
          },
          customerCost: {
            $sum: {
              $ifNull: [
                "$costBreakdown.customerCost",
                {
                  $add: [
                    { $ifNull: ["$costBreakdown.llm", 0] },
                    { $ifNull: ["$costBreakdown.stt", 0] },
                    { $ifNull: ["$costBreakdown.tts", 0] },
                  ],
                },
              ],
            },
          },
          llmTokens: { $sum: "$llmTokens" },
          sttSeconds: { $sum: "$sttSeconds" },
          ttsCharacters: { $sum: "$ttsCharacters" },
        },
      },
    ]),
    BillingTransactionModel.aggregate([
      { $match: { orgId, category: "call", type: { $in: ["deduction", "refund"] }, createdAt: { $gte: monthStart() } } },
      { $group: { _id: null, chargedCredits: { $sum: "$amountCredits" } } },
    ]),
  ]);
  const call = callUsage[0] ?? {};
  const credits = creditUsage[0] ?? {};
  return {
    agents,
    members,
    phoneNumbers,
    calls: call.calls ?? 0,
    minutes: Math.round(((call.seconds ?? 0) / 60) * 100) / 100,
    providerCost: call.providerCost ?? 0,
    customerCost: call.customerCost ?? call.providerCost ?? 0,
    llmTokens: call.llmTokens ?? 0,
    sttSeconds: call.sttSeconds ?? 0,
    ttsCharacters: call.ttsCharacters ?? 0,
    chargedCredits: Math.max(0, -(credits.chargedCredits ?? 0)),
  };
}

export async function assertCallCapacity(orgId: string) {
  const wallet = await ensureCreditWallet(orgId);
  if (wallet.balanceCredits < creditBillingSettings.minimumCallStartCredits) {
    throw new HttpError(
      402,
      `Insufficient credits. Add at least $${creditBillingSettings.minimumCallStartCredits.toFixed(2)} before starting a call.`,
    );
  }
}

export async function recentCreditTransactions(orgId: string, limit = 50) {
  // Per-call ledger rows remain internal and are surfaced with the associated
  // call in Call Logs. Billing history is reserved for customer-facing money
  // movement such as purchases, auto-reloads, and account adjustments.
  return BillingTransactionModel.find({ orgId, category: { $ne: "call" } })
    .sort({ createdAt: -1 })
    .limit(Math.min(100, Math.max(1, limit)));
}

export async function updateAutoReloadSettings(
  orgId: string,
  input: { enabled: boolean; thresholdCredits: number; reloadAmountCredits: number },
) {
  return CreditWalletModel.findOneAndUpdate(
    { orgId },
    {
      $setOnInsert: {
        orgId,
        balanceCredits: creditBillingSettings.initialCredits,
        lifetimePurchasedCredits: creditBillingSettings.initialCredits,
        currency: creditBillingSettings.currency,
      },
      $set: {
        autoReloadEnabled: input.enabled,
        reloadThresholdCredits: Math.max(0, roundedCredits(input.thresholdCredits)),
        reloadAmountCredits: Math.max(1, roundedCredits(input.reloadAmountCredits)),
        lastCheckedAt: new Date(),
      },
    },
    { new: true, upsert: true, runValidators: true },
  );
}

export async function recordCreditTopUp(input: {
  orgId: string;
  amountCredits: number;
  type?: "topup" | "auto_reload";
  category?: "payment" | "auto_reload";
  paymentProvider?: "razorpay" | "internal";
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  description?: string;
}) {
  const amountCredits = roundedCredits(input.amountCredits);
  if (amountCredits <= 0) throw new HttpError(400, "Top-up amount must be greater than zero.");
  const paymentClaimKey = input.razorpayPaymentId
    ? "razorpay:payment:" + input.razorpayPaymentId
    : input.razorpayOrderId
      ? "razorpay:order:" + input.razorpayOrderId
      : "";
  const paymentIdentityFilters: Record<string, string>[] = paymentClaimKey
    ? [
        { paymentClaimKey },
        ...(input.razorpayPaymentId ? [{ razorpayPaymentId: input.razorpayPaymentId }] : []),
        ...(input.razorpayOrderId ? [{ razorpayOrderId: input.razorpayOrderId }] : []),
      ]
    : [];
  await ensureCreditWallet(input.orgId);
  const session = await startSession();
  let transaction: HydratedDocument<BillingTransaction> | null = null;
  try {
    await session.withTransaction(async () => {
      transaction = null;
      if (paymentClaimKey) {
        const existing = await BillingTransactionModel.findOne({ $or: paymentIdentityFilters })
          .select("+paymentClaimKey")
          .session(session);
        if (existing) {
          if (!existing.paymentClaimKey) {
            await BillingTransactionModel.updateOne(
              { _id: existing._id, paymentClaimKey: { $in: [null, ""] } },
              { $set: { paymentClaimKey } },
              { session },
            );
          }
          transaction = existing;
          return;
        }
      }

      // The wallet credit and its unique provider claim commit together. A
      // retried payment webhook can never increment without the ledger row.
      const wallet = await CreditWalletModel.findOneAndUpdate(
        { orgId: input.orgId },
        {
          $inc: { balanceCredits: amountCredits, lifetimePurchasedCredits: amountCredits },
          $set: {
            paymentProvider: input.paymentProvider ?? (input.razorpayPaymentId ? "razorpay" : "internal"),
            lastPaymentStatus: "success",
            lastPaymentAmountCredits: amountCredits,
            lastPaymentAt: new Date(),
            lastCheckedAt: new Date(),
          },
          ...(input.type === "auto_reload"
            ? { $unset: { autoReloadLockUntil: "", autoReloadIdempotencyKey: "" } }
            : {}),
        },
        { new: true, runValidators: true, session },
      );
      if (!wallet) throw new Error("Credit wallet disappeared during top-up settlement.");

      [transaction] = await BillingTransactionModel.create([{
        orgId: input.orgId,
        type: input.type ?? "topup",
        category: input.category ?? "payment",
        amountCredits,
        currency: creditBillingSettings.currency,
        description: input.description ?? `Credit top-up: $${amountCredits.toFixed(2)}`,
        ...(input.razorpayOrderId ? { razorpayOrderId: input.razorpayOrderId } : {}),
        ...(input.razorpayPaymentId ? { razorpayPaymentId: input.razorpayPaymentId } : {}),
        ...(paymentClaimKey ? { paymentClaimKey } : {}),
        balanceAfterCredits: wallet.balanceCredits,
      }], { session });
    }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
  } catch (error) {
    if (!paymentClaimKey || !isDuplicateKeyError(error)) throw error;
    // Concurrent payment deliveries may both observe an empty snapshot. The
    // unique claim aborts the loser transaction (including its wallet credit),
    // then the loser returns the already-committed ledger row idempotently.
    for (const delayMs of [0, 25, 100]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      transaction = await BillingTransactionModel.findOne({ $or: paymentIdentityFilters })
        .select("+paymentClaimKey");
      if (transaction) break;
    }
    if (!transaction) throw error;
  } finally {
    await session.endSession();
  }
  if (!transaction) throw new Error("Credit top-up transaction completed without a ledger result.");
  return transaction as HydratedDocument<BillingTransaction>;
}

export async function deductCreditsForCall(call: {
  id: string;
  ownerId: string;
  durationSeconds: number;
  llmTokens: number;
  sttSeconds: number;
  ttsCharacters: number;
  billingUsageRevision: number;
  costBreakdown?: {
    pricingStatus?: "exact" | "estimated" | "unpriced";
    llm?: number;
    stt?: number;
    tts?: number;
    telephony?: number;
    providerCost?: number;
    platformFee?: number;
    customerCost?: number;
    total?: number;
  };
}) {
  const pricingIsUnpriced = call.costBreakdown?.pricingStatus === "unpriced";
  const providerCost = roundedCredits(
    call.costBreakdown?.providerCost ??
      ((call.costBreakdown?.llm ?? 0) +
        (call.costBreakdown?.stt ?? 0) +
        (call.costBreakdown?.tts ?? 0)),
  );
  const platformFee = roundedCredits(call.costBreakdown?.platformFee ?? 0);
  const targetCharge = roundedCredits(
    call.costBreakdown?.customerCost ??
      call.costBreakdown?.total ??
      (providerCost + platformFee),
  );
  if (targetCharge < 0) return null;

  const deductionKey = `call:${call.ownerId}:${call.id}:deduction`;
  const refundKey = `call:${call.ownerId}:${call.id}:refund`;
  await ensureCreditWallet(call.ownerId);
  const session = await startSession();
  let transaction: HydratedDocument<BillingTransaction> | null = null;
  type WalletAfterDeduction = {
    balanceCredits: number;
    autoReloadEnabled: boolean;
    reloadThresholdCredits: number;
    reloadAmountCredits: number;
  };
  let walletAfter: WalletAfterDeduction | null = null;

  try {
    await session.withTransaction(async () => {
      // withTransaction can retry this callback after a write conflict, so no
      // state from a previous attempt may leak into the committed result.
      transaction = null;
      walletAfter = null;

      const existingAdjustments = await BillingTransactionModel.find({
        orgId: call.ownerId,
        callId: call.id,
        type: { $in: ["deduction", "refund"] },
      })
        .select("amountCredits metadata createdAt +deductionKey")
        .session(session);
      const latestAdjustment = [...existingAdjustments]
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
      const recordedRevisions = existingAdjustments
        .map((item) => Number((item.metadata as Record<string, unknown> | undefined)?.billingUsageRevision))
        .filter(Number.isFinite);
      // Legacy ledger rows did not store a provider-usage revision. Freeze
      // those settled calls: a deployment or pricing-catalog change must not
      // retroactively debit or refund them.
      if (existingAdjustments.length && !recordedRevisions.length) {
        transaction = latestAdjustment;
        const currentWallet = await CreditWalletModel.findOne({ orgId: call.ownerId }).session(session);
        if (currentWallet) {
          walletAfter = {
            balanceCredits: currentWallet.balanceCredits,
            autoReloadEnabled: currentWallet.autoReloadEnabled,
            reloadThresholdCredits: currentWallet.reloadThresholdCredits,
            reloadAmountCredits: currentWallet.reloadAmountCredits,
          };
        }
        return;
      }
      const lastSettledUsageRevision = recordedRevisions.length ? Math.max(...recordedRevisions) : -1;
      if (existingAdjustments.length && call.billingUsageRevision <= lastSettledUsageRevision) {
        transaction = latestAdjustment;
        const currentWallet = await CreditWalletModel.findOne({ orgId: call.ownerId }).session(session);
        if (currentWallet) {
          walletAfter = {
            balanceCredits: currentWallet.balanceCredits,
            autoReloadEnabled: currentWallet.autoReloadEnabled,
            reloadThresholdCredits: currentWallet.reloadThresholdCredits,
            reloadAmountCredits: currentWallet.reloadAmountCredits,
          };
        }
        return;
      }
      const ledgerAmounts = existingAdjustments.map((item) => item.amountCredits);
      const { netCharged } = callChargeAdjustment(0, ledgerAmounts);
      // Incomplete pricing can reconcile a previous charge downward, but it
      // must never create or increase a customer charge.
      const settlementTarget = pricingIsUnpriced
        ? Math.min(targetCharge, netCharged)
        : targetCharge;
      const { delta } = callChargeAdjustment(
        settlementTarget,
        ledgerAmounts,
      );
      const adjustmentKey = delta < 0 ? refundKey : deductionKey;
      const adjustmentType = delta < 0 ? "refund" : "deduction";
      const existingClaim = existingAdjustments.find((item) => item.deductionKey === adjustmentKey) ?? null;
      if (Math.abs(delta) <= 0.000001) {
        transaction = existingClaim;
        const currentWallet = await CreditWalletModel.findOne({ orgId: call.ownerId }).session(session);
        if (currentWallet) {
          walletAfter = {
            balanceCredits: currentWallet.balanceCredits,
            autoReloadEnabled: currentWallet.autoReloadEnabled,
            reloadThresholdCredits: currentWallet.reloadThresholdCredits,
            reloadAmountCredits: currentWallet.reloadAmountCredits,
          };
        }
        return;
      }

      // Wallet and ledger are one transaction. A crash or duplicate finalizer
      // can therefore neither debit/refund without a matching ledger row nor
      // apply the same revision adjustment twice.
      const wallet = await CreditWalletModel.findOneAndUpdate(
        { orgId: call.ownerId },
        { $inc: { balanceCredits: -delta }, $set: { lastCheckedAt: new Date() } },
        { new: true, runValidators: true, session },
      );
      if (!wallet) {
        throw new Error("Credit wallet disappeared during call settlement.");
      }

      const adjustmentAmount = roundedCredits(Math.abs(delta));
      const claimTotal = roundedCredits(Math.abs(existingClaim?.amountCredits ?? 0) + adjustmentAmount);
      transaction = await BillingTransactionModel.findOneAndUpdate(
        { deductionKey: adjustmentKey },
        {
          $setOnInsert: {
            orgId: call.ownerId,
            type: adjustmentType,
            category: "call",
            currency: creditBillingSettings.currency,
            callId: call.id,
            deductionKey: adjustmentKey,
          },
          $inc: { amountCredits: -delta },
          $set: {
            description: adjustmentType === "refund"
              ? `Call usage reconciliation refund (${Math.ceil(call.durationSeconds / 60)} min)`
              : `Call usage (${Math.ceil(call.durationSeconds / 60)} min)`,
            balanceAfterCredits: wallet.balanceCredits,
            breakdown: {
              llm: roundedCredits(call.costBreakdown?.llm ?? 0),
              stt: roundedCredits(call.costBreakdown?.stt ?? 0),
              tts: roundedCredits(call.costBreakdown?.tts ?? 0),
              telephony: 0,
              providerCost,
              platformFee,
              customerCost: targetCharge,
              markupMultiplier: 1,
              total: claimTotal,
            },
            metadata: {
              targetCharge: settlementTarget,
              calculatedProviderCost: providerCost,
              calculatedPlatformFee: platformFee,
              netChargedBeforeAdjustment: netCharged,
              adjustment: delta,
              llmTokens: call.llmTokens,
              sttSeconds: call.sttSeconds,
              ttsCharacters: call.ttsCharacters,
              pricingStatus: call.costBreakdown?.pricingStatus ?? "exact",
              billingUsageRevision: call.billingUsageRevision,
              chargeIncreaseBlocked: pricingIsUnpriced && targetCharge > netCharged,
            },
          },
        },
        { new: true, upsert: true, runValidators: true, session },
      );
      walletAfter = {
        balanceCredits: wallet.balanceCredits,
        autoReloadEnabled: wallet.autoReloadEnabled,
        reloadThresholdCredits: wallet.reloadThresholdCredits,
        reloadAmountCredits: wallet.reloadAmountCredits,
      };
    }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
  } finally {
    await session.endSession();
  }

  return transaction;
}


