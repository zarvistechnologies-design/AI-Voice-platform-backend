import { BillingSubscriptionModel } from "../models/BillingSubscription.js";
import { BillingTransactionModel } from "../models/BillingTransaction.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { CreditWalletModel } from "../models/CreditWallet.js";
import { OrganizationMemberModel } from "../models/OrganizationMember.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { env } from "../config/env.js";
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

export const creditBillingSettings = {
  currency: "USD",
  initialCredits: positiveNumber(env.billing.initialCredits, 1000),
  minimumCallStartCredits: positiveNumber(env.billing.minimumCallStartCredits, 0.05),
  markupMultiplier: positiveNumber(env.billing.markupMultiplier, 2.5),
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
          totalCost: { $sum: "$costBreakdown.total" },
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
    providerCost: call.totalCost ?? 0,
    llmTokens: call.llmTokens ?? 0,
    sttSeconds: call.sttSeconds ?? 0,
    ttsCharacters: call.ttsCharacters ?? 0,
    chargedCredits: Math.abs(credits.chargedCredits ?? 0),
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
  if (input.stripeSessionId) {
    const existing = await BillingTransactionModel.findOne({ stripeSessionId: input.stripeSessionId });
    if (existing) return existing;
  }
  if (input.stripePaymentIntentId) {
    const existing = await BillingTransactionModel.findOne({ stripePaymentIntentId: input.stripePaymentIntentId });
    if (existing) return existing;
  }

  await ensureCreditWallet(input.orgId);
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
      $unset: { autoReloadLockUntil: "" },
    },
    { new: true, upsert: true, runValidators: true },
  );

  try {
    return await BillingTransactionModel.create({
      orgId: input.orgId,
      type: input.type ?? "topup",
      category: input.category ?? "payment",
      amountCredits,
      currency: creditBillingSettings.currency,
      description: input.description ?? `Credit top-up: $${amountCredits.toFixed(2)}`,
      stripeSessionId: input.stripeSessionId,
      stripePaymentIntentId: input.stripePaymentIntentId ?? "",
      balanceAfterCredits: wallet.balanceCredits,
    });
  } catch (error) {
    if (input.stripeSessionId && typeof error === "object" && error && "code" in error && error.code === 11000) {
      await CreditWalletModel.updateOne({ orgId: input.orgId }, { $inc: { balanceCredits: -amountCredits, lifetimePurchasedCredits: -amountCredits } });
      const existing = await BillingTransactionModel.findOne({ stripeSessionId: input.stripeSessionId });
      if (existing) return existing;
    }
    throw error;
  }
}

async function maybeMarkAutoReloadCheck(orgId: string) {
  await CreditWalletModel.updateOne({ orgId }, { $set: { lastCheckedAt: new Date() } });
}

async function attemptAutoReload(wallet: {
  orgId: string;
  autoReloadEnabled: boolean;
  balanceCredits: number;
  reloadThresholdCredits: number;
  reloadAmountCredits: number;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
}) {
  if (
    !wallet.autoReloadEnabled ||
    wallet.balanceCredits > wallet.reloadThresholdCredits ||
    !stripeConfigured() ||
    !wallet.stripeCustomerId ||
    !wallet.stripePaymentMethodId
  ) {
    await maybeMarkAutoReloadCheck(wallet.orgId);
    return;
  }

  const now = new Date();
  const locked = await CreditWalletModel.findOneAndUpdate(
    {
      orgId: wallet.orgId,
      $or: [
        { autoReloadLockUntil: { $exists: false } },
        { autoReloadLockUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        autoReloadLockUntil: new Date(now.getTime() + 30_000),
        lastPaymentStatus: "pending",
        lastCheckedAt: now,
      },
    },
    { new: true },
  );
  if (!locked) return;

  const amountCredits = Math.max(1, roundedCredits(wallet.reloadAmountCredits));
  try {
    await stripeRequest<{ id: string; status?: string }>("/payment_intents", {
      amount: String(Math.round(amountCredits * 100)),
      currency: "usd",
      customer: wallet.stripeCustomerId,
      payment_method: wallet.stripePaymentMethodId,
      confirm: "true",
      off_session: "true",
      "metadata[kind]": "credit_auto_reload",
      "metadata[orgId]": wallet.orgId,
      "metadata[credits]": amountCredits.toFixed(2),
    });
  } catch (error) {
    await CreditWalletModel.updateOne(
      { orgId: wallet.orgId },
      {
        $set: { lastPaymentStatus: "failed", lastCheckedAt: new Date() },
        $unset: { autoReloadLockUntil: "" },
      },
    );
    throw error;
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
    llm?: number;
    stt?: number;
    tts?: number;
    telephony?: number;
    total?: number;
  };
}) {
  const providerCost = roundedCredits(call.costBreakdown?.total ?? 0);
  const targetCharge = roundedCredits(providerCost * creditBillingSettings.markupMultiplier);
  if (targetCharge <= 0) return null;

  const [existing] = await BillingTransactionModel.aggregate([
    { $match: { orgId: call.ownerId, callId: call.id, type: "deduction" } },
    { $group: { _id: null, amountCredits: { $sum: "$amountCredits" } } },
  ]);
  const alreadyDeducted = Math.abs(existing?.amountCredits ?? 0);
  const delta = roundedCredits(targetCharge - alreadyDeducted);
  if (delta <= 0.000001) return null;

  const wallet = await CreditWalletModel.findOneAndUpdate(
    { orgId: call.ownerId, balanceCredits: { $gte: delta } },
    { $inc: { balanceCredits: -delta }, $set: { lastCheckedAt: new Date() } },
    { new: true, runValidators: true },
  );
  if (!wallet) {
    await maybeMarkAutoReloadCheck(call.ownerId);
    return null;
  }

  const transaction = await BillingTransactionModel.create({
    orgId: call.ownerId,
    type: "deduction",
    category: "call",
    amountCredits: -delta,
    currency: creditBillingSettings.currency,
    description: `Call usage (${Math.ceil(call.durationSeconds / 60)} min)`,
    callId: call.id,
    balanceAfterCredits: wallet.balanceCredits,
    breakdown: {
      llm: roundedCredits(call.costBreakdown?.llm ?? 0),
      stt: roundedCredits(call.costBreakdown?.stt ?? 0),
      tts: roundedCredits(call.costBreakdown?.tts ?? 0),
      telephony: roundedCredits(call.costBreakdown?.telephony ?? 0),
      providerCost,
      markupMultiplier: creditBillingSettings.markupMultiplier,
      total: delta,
    },
    metadata: {
      targetCharge,
      alreadyDeducted,
      llmTokens: call.llmTokens,
      sttSeconds: call.sttSeconds,
      ttsCharacters: call.ttsCharacters,
    },
  });

  if (wallet.autoReloadEnabled && wallet.balanceCredits <= wallet.reloadThresholdCredits) {
    await attemptAutoReload({
      orgId: call.ownerId,
      autoReloadEnabled: wallet.autoReloadEnabled,
      balanceCredits: wallet.balanceCredits,
      reloadThresholdCredits: wallet.reloadThresholdCredits,
      reloadAmountCredits: wallet.reloadAmountCredits,
      stripeCustomerId: wallet.stripeCustomerId,
      stripePaymentMethodId: wallet.stripePaymentMethodId,
    });
  }

  return transaction;
}

export async function stripeRequest<T>(path: string, values: Record<string, string>) {
  if (!env.stripeSecretKey) throw new HttpError(503, "Stripe billing is not configured.");
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values),
  });
  const data = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) throw new HttpError(502, data.error?.message ?? "Stripe request failed.");
  return data;
}

export async function stripeGet<T>(path: string) {
  if (!env.stripeSecretKey) throw new HttpError(503, "Stripe billing is not configured.");
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${env.stripeSecretKey}`,
    },
  });
  const data = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) throw new HttpError(502, data.error?.message ?? "Stripe request failed.");
  return data;
}
