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

function isDuplicateKeyError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === 11000);
}

export const creditBillingSettings = {
  currency: "USD",
  initialCredits: positiveNumber(env.billing.initialCredits, 1000),
  minimumCallStartCredits: positiveNumber(env.billing.minimumCallStartCredits, 0.05),
  markupMultiplier: 1,
  platformFeeInrPerCall: 0,
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
              $add: [
                { $ifNull: ["$costBreakdown.llm", 0] },
                { $ifNull: ["$costBreakdown.stt", 0] },
                { $ifNull: ["$costBreakdown.tts", 0] },
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
      { $match: { orgId, type: "deduction", createdAt: { $gte: monthStart() } } },
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
    customerCost: call.providerCost ?? 0,
    llmTokens: call.llmTokens ?? 0,
    sttSeconds: call.sttSeconds ?? 0,
    ttsCharacters: call.ttsCharacters ?? 0,
    chargedCredits: call.providerCost ?? Math.abs(credits.chargedCredits ?? 0),
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
  return BillingTransactionModel.find({ orgId })
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
  if (call.costBreakdown?.pricingStatus === "unpriced") {
    console.error(JSON.stringify({
      event: "call-billing-skipped-unpriced",
      callId: call.id,
      ownerId: call.ownerId,
    }));
    return null;
  }
  const providerCost = roundedCredits(
    call.costBreakdown?.providerCost ??
      ((call.costBreakdown?.llm ?? 0) +
        (call.costBreakdown?.stt ?? 0) +
        (call.costBreakdown?.tts ?? 0)),
  );
  const platformFee = 0;
  const targetCharge = providerCost;
  if (targetCharge <= 0) return null;

  const deductionKey = `call:${call.ownerId}:${call.id}:deduction`;
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

      const existingDeductions = await BillingTransactionModel.find({
        orgId: call.ownerId,
        callId: call.id,
        type: "deduction",
      })
        .select("amountCredits +deductionKey")
        .session(session);
      const alreadyDeducted = roundedCredits(Math.abs(
        existingDeductions.reduce((sum, item) => sum + item.amountCredits, 0),
      ));
      const delta = roundedCredits(targetCharge - alreadyDeducted);
      const existingClaim = existingDeductions.find((item) => item.deductionKey === deductionKey) ?? null;
      if (delta <= 0.000001) {
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
      // can therefore neither debit without a row nor create two deductions.
      const wallet = await CreditWalletModel.findOneAndUpdate(
        { orgId: call.ownerId },
        { $inc: { balanceCredits: -delta }, $set: { lastCheckedAt: new Date() } },
        { new: true, runValidators: true, session },
      );
      if (!wallet) {
        throw new Error("Credit wallet disappeared during call settlement.");
      }

      const claimTotal = roundedCredits(Math.abs(existingClaim?.amountCredits ?? 0) + delta);
      transaction = await BillingTransactionModel.findOneAndUpdate(
        { deductionKey },
        {
          $setOnInsert: {
            orgId: call.ownerId,
            type: "deduction",
            category: "call",
            currency: creditBillingSettings.currency,
            callId: call.id,
            deductionKey,
          },
          $inc: { amountCredits: -delta },
          $set: {
            description: `Call usage (${Math.ceil(call.durationSeconds / 60)} min)`,
            balanceAfterCredits: wallet.balanceCredits,
            breakdown: {
              llm: roundedCredits(call.costBreakdown?.llm ?? 0),
              stt: roundedCredits(call.costBreakdown?.stt ?? 0),
              tts: roundedCredits(call.costBreakdown?.tts ?? 0),
              telephony: 0,
              providerCost,
              platformFee,
              customerCost: providerCost,
              markupMultiplier: 1,
              total: claimTotal,
            },
            metadata: {
              targetCharge,
              alreadyDeducted,
              llmTokens: call.llmTokens,
              sttSeconds: call.sttSeconds,
              ttsCharacters: call.ttsCharacters,
              pricingStatus: call.costBreakdown?.pricingStatus ?? "exact",
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


