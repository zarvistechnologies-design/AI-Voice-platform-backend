import { randomUUID } from "node:crypto";
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

export function stripeConfigured() {
  return Boolean(env.stripeSecretKey && env.stripeWebhookSecret);
}

function positiveNumber(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function roundedCredits(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isDuplicateKeyError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === 11000);
}

class StripeRequestError extends HttpError {
  readonly providerStatusCode: number;
  readonly definitiveRejection: boolean;

  constructor(providerStatusCode: number, message: string) {
    super(502, message);
    this.providerStatusCode = providerStatusCode;
    // Most Stripe 4xx responses are definitive API rejections. Request
    // timeout, idempotency-key-in-use, and rate-limit responses can still hide
    // an in-flight attempt, so 408/409/429 retain the same key like transport
    // failures, malformed upstream responses, and 5xx responses.
    this.definitiveRejection =
      providerStatusCode >= 400
      && providerStatusCode < 500
      && ![408, 409, 429].includes(providerStatusCode);
  }
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
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  stripeCustomerId?: string;
  stripePaymentMethodId?: string;
  description?: string;
}) {
  const amountCredits = roundedCredits(input.amountCredits);
  if (amountCredits <= 0) throw new HttpError(400, "Top-up amount must be greater than zero.");
  const paymentClaimKey = input.stripePaymentIntentId
    ? `stripe:payment-intent:${input.stripePaymentIntentId}`
    : input.stripeSessionId
      ? `stripe:checkout-session:${input.stripeSessionId}`
      : "";
  const paymentIdentityFilters: Record<string, string>[] = paymentClaimKey
    ? [
        { paymentClaimKey },
        ...(input.stripePaymentIntentId ? [{ stripePaymentIntentId: input.stripePaymentIntentId }] : []),
        ...(input.stripeSessionId ? [{ stripeSessionId: input.stripeSessionId }] : []),
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
      // retried Stripe webhook can never increment without the ledger row.
      const wallet = await CreditWalletModel.findOneAndUpdate(
        { orgId: input.orgId },
        {
          $inc: { balanceCredits: amountCredits, lifetimePurchasedCredits: amountCredits },
          $set: {
            paymentProvider: input.stripeCustomerId ? "stripe" : "internal",
            ...(input.stripeCustomerId ? { stripeCustomerId: input.stripeCustomerId } : {}),
            ...(input.stripePaymentMethodId ? { stripePaymentMethodId: input.stripePaymentMethodId } : {}),
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
        stripeSessionId: input.stripeSessionId,
        stripePaymentIntentId: input.stripePaymentIntentId ?? "",
        ...(paymentClaimKey ? { paymentClaimKey } : {}),
        balanceAfterCredits: wallet.balanceCredits,
      }], { session });
    }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
  } catch (error) {
    if (!paymentClaimKey || !isDuplicateKeyError(error)) throw error;
    // Concurrent Stripe deliveries may both observe an empty snapshot. The
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

async function maybeMarkAutoReloadCheck(orgId: string) {
  await CreditWalletModel.updateOne({ orgId }, { $set: { lastCheckedAt: new Date() } });
}

async function attemptAutoReload(orgId: string) {
  if (!stripeConfigured()) {
    await maybeMarkAutoReloadCheck(orgId);
    return;
  }
  const now = new Date();
  const locked = await CreditWalletModel.findOneAndUpdate(
    {
      orgId,
      autoReloadEnabled: true,
      stripeCustomerId: { $exists: true, $type: "string", $ne: "" },
      stripePaymentMethodId: { $exists: true, $type: "string", $ne: "" },
      $expr: { $lte: ["$balanceCredits", "$reloadThresholdCredits"] },
      $or: [
        { autoReloadLockUntil: { $exists: false } },
        { autoReloadLockUntil: null },
        { autoReloadLockUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        autoReloadLockUntil: new Date(now.getTime() + 90_000),
        lastPaymentStatus: "pending",
        lastCheckedAt: now,
      },
    },
    { new: true },
  ).select("+autoReloadIdempotencyKey");
  if (!locked) {
    await maybeMarkAutoReloadCheck(orgId);
    return;
  }

  // Every payment input comes from the atomically claimed current wallet, not
  // from the deduction transaction's potentially stale snapshot.
  const amountCredits = Math.max(1, roundedCredits(locked.reloadAmountCredits));
  let idempotencyKey = locked.autoReloadIdempotencyKey;
  if (!idempotencyKey) {
    const proposedKey = `auto-reload:${locked.orgId}:${randomUUID()}`;
    const claimed = await CreditWalletModel.findOneAndUpdate(
      {
        _id: locked._id,
        autoReloadIdempotencyKey: { $in: [null, ""] },
      },
      { $set: { autoReloadIdempotencyKey: proposedKey } },
      { new: true },
    ).select("+autoReloadIdempotencyKey");
    idempotencyKey = claimed?.autoReloadIdempotencyKey
      ?? (await CreditWalletModel.findById(locked._id).select("+autoReloadIdempotencyKey"))?.autoReloadIdempotencyKey
      ?? "";
  }
  if (!idempotencyKey) {
    throw new Error("Auto-reload could not acquire a durable Stripe idempotency key.");
  }
  let paymentIntent: { id: string; status?: string };
  try {
    paymentIntent = await stripeRequest<{ id: string; status?: string }>("/payment_intents", {
      amount: String(Math.round(amountCredits * 100)),
      currency: "usd",
      customer: locked.stripeCustomerId,
      payment_method: locked.stripePaymentMethodId,
      confirm: "true",
      off_session: "true",
      "metadata[kind]": "credit_auto_reload",
      "metadata[orgId]": locked.orgId,
      "metadata[credits]": amountCredits.toFixed(2),
    }, { idempotencyKey });
  } catch (error) {
    const definitiveRejection = error instanceof StripeRequestError && error.definitiveRejection;
    await CreditWalletModel.updateOne(
      { orgId: locked.orgId, autoReloadIdempotencyKey: idempotencyKey },
      {
        $set: { lastPaymentStatus: "failed", lastCheckedAt: new Date() },
        $unset: {
          autoReloadLockUntil: "",
          ...(definitiveRejection ? { autoReloadIdempotencyKey: "" } : {}),
        },
      },
    );
    throw error;
  }

  if (["canceled", "requires_payment_method"].includes(paymentIntent.status ?? "")) {
    await CreditWalletModel.updateOne(
      { orgId: locked.orgId, autoReloadIdempotencyKey: idempotencyKey },
      {
        $set: { lastPaymentStatus: "failed", lastCheckedAt: new Date() },
        $unset: { autoReloadLockUntil: "", autoReloadIdempotencyKey: "" },
      },
    );
    throw new HttpError(402, `Stripe rejected the automatic reload (${paymentIntent.status}).`);
  }

  if (paymentIntent.status === "succeeded" && paymentIntent.id) {
    try {
      await recordCreditTopUp({
        orgId: locked.orgId,
        amountCredits,
        type: "auto_reload",
        category: "auto_reload",
        stripePaymentIntentId: paymentIntent.id,
        stripeCustomerId: locked.stripeCustomerId,
        stripePaymentMethodId: locked.stripePaymentMethodId,
        description: `Automatic credit reload: $${amountCredits.toFixed(2)}`,
      });
    } catch (error) {
      // Stripe has confirmed the charge. Keep the durable idempotency key and
      // pending state so a finalizer retry or webhook can settle it safely.
      await CreditWalletModel.updateOne(
        { orgId: locked.orgId, autoReloadIdempotencyKey: idempotencyKey },
        {
          $set: { lastPaymentStatus: "pending", lastCheckedAt: new Date() },
          $unset: { autoReloadLockUntil: "" },
        },
      ).catch(() => undefined);
      throw error;
    }
  }
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
    stripeCustomerId: string;
    stripePaymentMethodId: string;
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
            stripeCustomerId: currentWallet.stripeCustomerId,
            stripePaymentMethodId: currentWallet.stripePaymentMethodId,
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
        stripeCustomerId: wallet.stripeCustomerId,
        stripePaymentMethodId: wallet.stripePaymentMethodId,
      };
    }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
  } finally {
    await session.endSession();
  }

  const committedWallet = walletAfter as WalletAfterDeduction | null;
  if (committedWallet?.autoReloadEnabled && committedWallet.balanceCredits <= committedWallet.reloadThresholdCredits) {
    // The call charge is already committed. Auto-reload is an independent,
    // best-effort replenishment and must never delay or fail terminal call
    // webhooks, transcript delivery, or post-call integrations.
    void attemptAutoReload(call.ownerId).catch((error) => {
      console.error(JSON.stringify({
        event: "billing-auto-reload-attempt-failed",
        orgId: call.ownerId,
        callId: call.id,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      }));
    });
  }

  return transaction;
}

export async function stripeRequest<T>(
  path: string,
  values: Record<string, string>,
  options: { idempotencyKey?: string } = {},
) {
  if (!env.stripeSecretKey) throw new HttpError(503, "Stripe billing is not configured.");
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${env.stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    body: new URLSearchParams(values),
  });
  const responseText = await response.text();
  let data: T & { error?: { message?: string } };
  try {
    data = JSON.parse(responseText) as T & { error?: { message?: string } };
  } catch {
    if (!response.ok) {
      throw new StripeRequestError(response.status, `Stripe request failed with HTTP ${response.status}.`);
    }
    throw new HttpError(502, "Stripe returned an invalid response.");
  }
  if (!response.ok) {
    throw new StripeRequestError(response.status, data.error?.message ?? "Stripe request failed.");
  }
  return data;
}

export async function stripeGet<T>(path: string) {
  if (!env.stripeSecretKey) throw new HttpError(503, "Stripe billing is not configured.");
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${env.stripeSecretKey}`,
    },
  });
  const data = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) throw new HttpError(502, data.error?.message ?? "Stripe request failed.");
  return data;
}
