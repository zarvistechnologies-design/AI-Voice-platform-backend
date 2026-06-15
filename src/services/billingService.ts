import { BillingSubscriptionModel } from "../models/BillingSubscription.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { OrganizationMemberModel } from "../models/OrganizationMember.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

export const planCatalog = {
  free: {
    id: "free",
    name: "Free",
    monthlyPrice: 0,
    limits: { agents: 1, members: 2, phoneNumbers: 0, monthlyMinutes: 60 },
  },
  starter: {
    id: "starter",
    name: "Starter",
    monthlyPrice: 49,
    limits: { agents: 5, members: 5, phoneNumbers: 3, monthlyMinutes: 1000 },
  },
  growth: {
    id: "growth",
    name: "Growth",
    monthlyPrice: 199,
    limits: { agents: 25, members: 25, phoneNumbers: 20, monthlyMinutes: 10000 },
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    monthlyPrice: null,
    limits: { agents: null, members: null, phoneNumbers: null, monthlyMinutes: null },
  },
} as const;

export type PlanId = keyof typeof planCatalog;

export function stripeConfigured() {
  return Boolean(env.stripeSecretKey && env.stripeWebhookSecret);
}

export async function ensureBillingSubscription(orgId: string) {
  return BillingSubscriptionModel.findOneAndUpdate(
    { orgId },
    { $setOnInsert: { orgId, plan: "free", status: "active", provider: "internal" } },
    { new: true, upsert: true, runValidators: true },
  );
}

function monthStart() {
  const date = new Date();
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export async function billingUsage(orgId: string) {
  const [agents, members, phoneNumbers, callUsage] = await Promise.all([
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
  ]);
  const call = callUsage[0] ?? {};
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
  };
}

export async function assertPlanCapacity(
  orgId: string,
  resource: "agents" | "members" | "phoneNumbers",
) {
  const subscription = await ensureBillingSubscription(orgId);
  const plan = planCatalog[subscription.plan as PlanId] ?? planCatalog.free;
  const limit = plan.limits[resource];
  if (limit === null) return;
  const usage = await billingUsage(orgId);
  if (usage[resource] >= limit) {
    throw new HttpError(402, `${plan.name} plan allows ${limit} ${resource}. Upgrade to continue.`);
  }
}

export async function assertCallCapacity(orgId: string) {
  const subscription = await ensureBillingSubscription(orgId);
  const plan = planCatalog[subscription.plan as PlanId] ?? planCatalog.free;
  const limit = plan.limits.monthlyMinutes;
  if (limit === null) return;
  const usage = await billingUsage(orgId);
  if (usage.minutes >= limit) {
    throw new HttpError(
      402,
      `${plan.name} plan includes ${limit.toLocaleString("en-US")} monthly minutes. Upgrade to start another call.`,
    );
  }
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

export function stripePriceForPlan(plan: PlanId) {
  return {
    starter: env.stripePriceStarter,
    growth: env.stripePriceGrowth,
    enterprise: env.stripePriceEnterprise,
    free: "",
  }[plan];
}
