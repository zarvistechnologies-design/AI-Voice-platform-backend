import { startSession, type HydratedDocument } from "mongoose";

import { Types } from "mongoose";

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
import { OrganizationModel } from "../models/Organization.js";
import { WhiteLabelSubscriptionModel } from "../models/WhiteLabelSubscription.js";
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
  const organization = env.whiteLabelEnabled
    ? await OrganizationModel.findById(orgId).select("whiteLabelAccountId").lean()
    : null;
  const initialCredits = organization?.whiteLabelAccountId ? 0 : creditBillingSettings.initialCredits;
  const whiteLabelSubscription = organization?.whiteLabelAccountId
    ? await WhiteLabelSubscriptionModel.findOne({ orgId }).select("priceSnapshot").lean()
    : null;
  const configuredCurrency = String(
    (whiteLabelSubscription?.priceSnapshot as Record<string, unknown> | undefined)?.currency
      ?? creditBillingSettings.currency,
  ).toUpperCase();
  const walletCurrency = configuredCurrency === "INR" ? "INR" : "USD";
  const wallet = await CreditWalletModel.findOneAndUpdate(
    { orgId },
    {
      $setOnInsert: {
        orgId,
        balanceCredits: initialCredits,
        lifetimePurchasedCredits: initialCredits,
        currency: walletCurrency,
      },
      $set: { lastCheckedAt: new Date() },
    },
    { new: true, upsert: true, runValidators: true },
  );

  if (
    initialCredits > 0 &&
    wallet.balanceCredits === 0 &&
    wallet.lifetimePurchasedCredits === 0
  ) {
    const upgradedWallet = await CreditWalletModel.findOneAndUpdate(
      { orgId, balanceCredits: 0, lifetimePurchasedCredits: 0 },
      {
        $set: {
          balanceCredits: initialCredits,
          lifetimePurchasedCredits: initialCredits,
          currency: walletCurrency,
          paymentProvider: "internal",
          lastPaymentStatus: "success",
          lastPaymentAmountCredits: initialCredits,
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
  const minimumCredits = wallet.currency === "INR"
    ? roundedCredits(creditBillingSettings.minimumCallStartCredits * env.costRates.inrPerUsd)
    : creditBillingSettings.minimumCallStartCredits;
  if (wallet.balanceCredits < minimumCredits) {
    const minimumLabel = wallet.currency === "INR"
      ? `INR ${minimumCredits.toFixed(2)}`
      : `$${creditBillingSettings.minimumCallStartCredits.toFixed(2)}`;
    throw new HttpError(
      402,
      `Insufficient credits. Add at least ${minimumLabel} before starting a call.`,
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
  await ensureCreditWallet(orgId);
  return CreditWalletModel.findOneAndUpdate(
    { orgId },
    {
      $set: {
        autoReloadEnabled: input.enabled,
        reloadThresholdCredits: Math.max(0, roundedCredits(input.thresholdCredits)),
        reloadAmountCredits: Math.max(1, roundedCredits(input.reloadAmountCredits)),
        lastCheckedAt: new Date(),
      },
    },
    { new: true, runValidators: true },
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
  idempotencyKey?: string;
}) {
  const amountCredits = roundedCredits(input.amountCredits);
  if (amountCredits <= 0) throw new HttpError(400, "Top-up amount must be greater than zero.");
  const paymentClaimKey = input.idempotencyKey
    ? `internal:${input.idempotencyKey}`
    : input.razorpayPaymentId
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
        currency: wallet.currency,
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

export function calculateWhiteLabelUsageCharge(input: {
  providerCostUsd: number;
  platformFeeUsd: number;
  durationSeconds: number;
  currency: "USD" | "INR";
  inrPerUsd: number;
  usagePricing: Record<string, unknown>;
  includedSecondsRemaining?: number;
}) {
  const fxRate = input.currency === "INR" ? positiveNumber(input.inrPerUsd, 1) : 1;
  const providerCost = roundedCredits(Math.max(0, input.providerCostUsd) * fxRate);
  const platformFee = roundedCredits(Math.max(0, input.platformFeeUsd) * fxRate);
  const wholesaleCost = roundedCredits(providerCost + platformFee);
  const pricingMode = String(input.usagePricing.mode ?? "cost_markup");
  const markupBps = Math.max(0, Math.min(100_000, Number(input.usagePricing.markupBps) || 0));
  const markupMultiplier = roundedCredits(1 + markupBps / 10_000);
  const durationSeconds = Math.max(0, input.durationSeconds);
  const includedSeconds = Math.max(0, Number(input.includedSecondsRemaining) || 0);
  const billableSeconds = Math.max(0, durationSeconds - includedSeconds);
  const billableFraction = durationSeconds > 0 ? billableSeconds / durationSeconds : 0;
  let targetCharge: number;
  if (pricingMode === "fixed_per_minute") {
    const perMinute = Math.max(0, Number(input.usagePricing.perMinuteAmountMinor) || 0) / 100;
    const minimum = Math.max(0, Number(input.usagePricing.minimumCallAmountMinor) || 0) / 100;
    targetCharge = billableSeconds > 0
      ? roundedCredits(Math.max(minimum, perMinute * billableSeconds / 60))
      : 0;
  } else if (pricingMode === "included_only") {
    targetCharge = 0;
  } else {
    targetCharge = roundedCredits(wholesaleCost * billableFraction * markupMultiplier);
  }
  return {
    targetCharge,
    providerCost,
    platformFee,
    wholesaleCost,
    partnerMargin: roundedCredits(targetCharge - wholesaleCost),
    fxRate,
    pricingMode,
    markupMultiplier,
  };
}

type CustomerCharge = {
  targetCharge: number;
  providerCost: number;
  platformFee: number;
  wholesaleCost: number;
  partnerMargin: number;
  currency: "USD" | "INR";
  fxRate: number;
  pricingMode: string;
  markupMultiplier: number;
  planKey: string;
  planVersion: number;
  llm: number;
  stt: number;
  tts: number;
  pricingIncomplete: boolean;
};

async function resolveCustomerCharge(call: {
  id: string;
  ownerId: string;
  durationSeconds: number;
  costBreakdown?: {
    pricingStatus?: "exact" | "estimated" | "unpriced";
    llm?: number;
    stt?: number;
    tts?: number;
    providerCost?: number;
    platformFee?: number;
    customerCost?: number;
    total?: number;
  };
}): Promise<CustomerCharge> {
  const sourceProviderCost = roundedCredits(
    call.costBreakdown?.providerCost ??
      ((call.costBreakdown?.llm ?? 0) +
        (call.costBreakdown?.stt ?? 0) +
        (call.costBreakdown?.tts ?? 0)),
  );
  const sourcePlatformFee = roundedCredits(call.costBreakdown?.platformFee ?? 0);
  const sourceTarget = roundedCredits(
    call.costBreakdown?.customerCost ??
      call.costBreakdown?.total ??
      (sourceProviderCost + sourcePlatformFee),
  );
  const subscription = env.whiteLabelEnabled
    ? await WhiteLabelSubscriptionModel.findOne({ orgId: call.ownerId })
      .select("planKey planVersion status priceSnapshot usagePricingSnapshot allowancesSnapshot currentPeriodStart")
      .lean()
    : null;
  if (!subscription) {
    return {
      targetCharge: sourceTarget,
      providerCost: sourceProviderCost,
      platformFee: sourcePlatformFee,
      wholesaleCost: roundedCredits(sourceProviderCost + sourcePlatformFee),
      partnerMargin: 0,
      currency: "USD",
      fxRate: 1,
      pricingMode: "platform",
      markupMultiplier: 1,
      planKey: "",
      planVersion: 0,
      llm: roundedCredits(call.costBreakdown?.llm ?? 0),
      stt: roundedCredits(call.costBreakdown?.stt ?? 0),
      tts: roundedCredits(call.costBreakdown?.tts ?? 0),
      pricingIncomplete: call.costBreakdown?.pricingStatus === "unpriced",
    };
  }
  const price = (subscription.priceSnapshot ?? {}) as Record<string, unknown>;
  const usage = (subscription.usagePricingSnapshot ?? {}) as Record<string, unknown>;
  const allowances = (subscription.allowancesSnapshot ?? {}) as Record<string, unknown>;
  const currency = price.currency === "INR" ? "INR" : "USD";
  const callMatch: Record<string, unknown> = {
    ownerId: call.ownerId,
    createdAt: { $gte: subscription.currentPeriodStart ?? monthStart() },
  };
  if (Types.ObjectId.isValid(call.id)) callMatch._id = { $ne: new Types.ObjectId(call.id) };
  const priorUsage = await CallDetailRecordModel.aggregate<{ seconds: number }>([
    { $match: callMatch },
    { $group: { _id: null, seconds: { $sum: "$durationSeconds" } } },
  ]);
  const includedSecondsRemaining = Math.max(
    0,
    Number(allowances.includedMinutes ?? 0) * 60 - Number(priorUsage[0]?.seconds ?? 0),
  );
  const calculated = calculateWhiteLabelUsageCharge({
    providerCostUsd: sourceProviderCost,
    platformFeeUsd: sourcePlatformFee,
    durationSeconds: call.durationSeconds,
    currency,
    inrPerUsd: env.costRates.inrPerUsd,
    usagePricing: usage,
    includedSecondsRemaining,
  });
  const { fxRate, providerCost, platformFee, wholesaleCost, pricingMode, markupMultiplier, targetCharge } = calculated;
  return {
    targetCharge,
    providerCost,
    platformFee,
    wholesaleCost,
    partnerMargin: calculated.partnerMargin,
    currency,
    fxRate,
    pricingMode,
    markupMultiplier,
    planKey: subscription.planKey,
    planVersion: subscription.planVersion,
    llm: roundedCredits((call.costBreakdown?.llm ?? 0) * fxRate),
    stt: roundedCredits((call.costBreakdown?.stt ?? 0) * fxRate),
    tts: roundedCredits((call.costBreakdown?.tts ?? 0) * fxRate),
    pricingIncomplete:
      call.costBreakdown?.pricingStatus === "unpriced" && pricingMode !== "fixed_per_minute",
  };
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
  const customerCharge = await resolveCustomerCharge(call);
  const pricingIsUnpriced = customerCharge.pricingIncomplete;
  const { providerCost, platformFee, targetCharge } = customerCharge;
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
            currency: wallet.currency,
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
              llm: customerCharge.llm,
              stt: customerCharge.stt,
              tts: customerCharge.tts,
              telephony: 0,
              providerCost,
              platformFee,
              customerCost: targetCharge,
              markupMultiplier: customerCharge.markupMultiplier,
              ...(customerCharge.pricingMode !== "platform" ? {
                wholesaleCost: customerCharge.wholesaleCost,
                partnerMargin: customerCharge.partnerMargin,
                fxRate: customerCharge.fxRate,
                sourceCurrency: "USD",
                billingCurrency: customerCharge.currency,
                pricingMode: customerCharge.pricingMode,
                planKey: customerCharge.planKey,
                planVersion: customerCharge.planVersion,
              } : {}),
              total: claimTotal,
            },
            metadata: {
              targetCharge: settlementTarget,
              calculatedProviderCost: providerCost,
              calculatedPlatformFee: platformFee,
              ...(customerCharge.pricingMode !== "platform" ? {
                wholesaleCost: customerCharge.wholesaleCost,
                partnerMargin: customerCharge.partnerMargin,
                fxRate: customerCharge.fxRate,
                sourceCurrency: "USD",
                billingCurrency: customerCharge.currency,
                pricingMode: customerCharge.pricingMode,
                planKey: customerCharge.planKey,
                planVersion: customerCharge.planVersion,
              } : {}),
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


