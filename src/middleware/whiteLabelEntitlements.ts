import type { NextFunction, Response } from "express";
import { Types } from "mongoose";

import type { AuthenticatedRequest } from "./auth.js";
import { env } from "../config/env.js";
import { ApiKeyModel } from "../models/ApiKey.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { KnowledgeSourceModel } from "../models/KnowledgeSource.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { WhiteLabelSubscriptionModel } from "../models/WhiteLabelSubscription.js";
import { HttpError } from "../utils/httpError.js";
import {
  assertAgentModelsAllowed,
  type WhiteLabelModelAccess,
} from "../services/whiteLabelModelAccessService.js";

type WhiteLabelFeature =
  | "campaigns"
  | "inboundCalling"
  | "outboundCalling"
  | "callRecording"
  | "knowledgeBase"
  | "integrations"
  | "developerApi"
  | "advancedAnalytics"
  | "teamAccess";

type WhiteLabelResource = "agents" | "phoneNumbers" | "knowledgeSources" | "apiKeys";

type SubscriptionContext = {
  id: string;
  status: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  limits: Record<string, unknown>;
  features: Record<string, unknown>;
  allowances: Record<string, unknown>;
  usagePricing: Record<string, unknown>;
  modelAccess?: WhiteLabelModelAccess;
};

export type WhiteLabelEntitledRequest = AuthenticatedRequest & {
  whiteLabelSubscription?: SubscriptionContext | null;
};

function limitValue(context: SubscriptionContext, key: string) {
  const value = Number(context.limits[key]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function writeStatusAllowed(context: SubscriptionContext) {
  return context.status === "trialing" || context.status === "active";
}

export async function requireWhiteLabelSubscription(
  request: WhiteLabelEntitledRequest,
  _response: Response,
  next: NextFunction,
) {
  try {
    if (!env.whiteLabelEnabled) {
      request.whiteLabelSubscription = null;
      next();
      return;
    }
    const accountId = request.organization?.whiteLabelAccountId;
    if (!accountId) {
      request.whiteLabelSubscription = null;
      next();
      return;
    }
    const subscription = await WhiteLabelSubscriptionModel.findOne({
      orgId: request.organization?.id,
      accountId,
      brandId: request.organization?.whiteLabelBrandId,
      status: { $in: ["trialing", "active", "past_due", "paused"] },
    }).lean();
    if (!subscription) throw new HttpError(402, "No active white-label subscription is assigned to this organization.");
    request.whiteLabelSubscription = {
      id: String(subscription._id),
      status: subscription.status,
      currentPeriodStart: subscription.currentPeriodStart ?? undefined,
      currentPeriodEnd: subscription.currentPeriodEnd ?? undefined,
      limits: (subscription.limitsSnapshot ?? {}) as Record<string, unknown>,
      features: (subscription.featuresSnapshot ?? {}) as Record<string, unknown>,
      allowances: (subscription.allowancesSnapshot ?? {}) as Record<string, unknown>,
      usagePricing: (subscription.usagePricingSnapshot ?? {}) as Record<string, unknown>,
      modelAccess: subscription.modelAccessSnapshot as WhiteLabelModelAccess | undefined,
    };
    next();
  } catch (error) {
    next(error);
  }
}

export function requireWhiteLabelWriteAccess(
  request: WhiteLabelEntitledRequest,
  _response: Response,
  next: NextFunction,
) {
  const context = request.whiteLabelSubscription;
  if (context && !writeStatusAllowed(context)) {
    next(new HttpError(402, `Customer subscription is ${context.status}. Resolve billing before making changes.`));
    return;
  }
  next();
}

export function requireWhiteLabelFeature(feature: WhiteLabelFeature) {
  return (request: WhiteLabelEntitledRequest, _response: Response, next: NextFunction) => {
    const context = request.whiteLabelSubscription;
    if (context && context.features[feature] !== true) {
      next(new HttpError(403, `${feature} is not included in this customer plan.`));
      return;
    }
    next();
  };
}

async function resourceCount(resource: WhiteLabelResource, orgId: string) {
  if (resource === "agents") return VoiceAgentModel.countDocuments({ ownerId: orgId });
  if (resource === "phoneNumbers") return PhoneNumberModel.countDocuments({ ownerId: orgId, lifecycle: { $ne: "deleting" } });
  if (resource === "knowledgeSources") return KnowledgeSourceModel.countDocuments({ ownerId: orgId, status: { $ne: "disabled" } });
  return ApiKeyModel.countDocuments({ orgId, revokedAt: { $exists: false } });
}

export function requireWhiteLabelResourceCapacity(resource: WhiteLabelResource) {
  return async (request: WhiteLabelEntitledRequest, _response: Response, next: NextFunction) => {
    try {
      const context = request.whiteLabelSubscription;
      const orgId = request.organization?.id;
      if (!context || !orgId) {
        next();
        return;
      }
      const limit = limitValue(context, resource);
      const count = await resourceCount(resource, orgId);
      if (count >= limit) throw new HttpError(409, `${resource} limit of ${limit} reached for this plan.`);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function enforceWhiteLabelAgentSettings(
  request: WhiteLabelEntitledRequest,
  _response: Response,
  next: NextFunction,
) {
  const context = request.whiteLabelSubscription;
  if (!context) {
    next();
    return;
  }
  const concurrency = Number(request.body.maxConcurrentCalls);
  const concurrencyLimit = limitValue(context, "concurrentCalls");
  if (Number.isFinite(concurrency) && concurrency > concurrencyLimit) {
    next(new HttpError(409, `Agent concurrency cannot exceed the plan limit of ${concurrencyLimit}.`));
    return;
  }
  const recordingEnabled = request.body.callSettings?.recordingEnabled === true;
  if (recordingEnabled && context.features.callRecording !== true) {
    next(new HttpError(403, "Call recording is not included in this customer plan."));
    return;
  }
  next();
}

export function assertWhiteLabelAgentModelAccess(
  request: WhiteLabelEntitledRequest,
  agent: Parameters<typeof assertAgentModelsAllowed>[1],
) {
  assertAgentModelsAllowed(request.whiteLabelSubscription?.modelAccess, agent);
}

export async function requireWhiteLabelCallCapacity(
  request: WhiteLabelEntitledRequest,
  _response: Response,
  next: NextFunction,
) {
  try {
    const context = request.whiteLabelSubscription;
    const orgId = request.organization?.id;
    if (!context || !orgId) {
      next();
      return;
    }
    if (!writeStatusAllowed(context)) {
      throw new HttpError(402, `Customer subscription is ${context.status}. Resolve billing before starting calls.`);
    }
    const requestedAgentId = String(request.body?.agentId ?? request.params.agentId ?? "");
    if (requestedAgentId && Types.ObjectId.isValid(requestedAgentId)) {
      const agent = await VoiceAgentModel.findOne({ _id: requestedAgentId, ownerId: orgId })
        .select("pipelineMode realtimeProvider realtimeModel llmProvider llmModel sttProvider sttModel ttsProvider ttsModel")
        .lean();
      if (agent) assertAgentModelsAllowed(context.modelAccess, agent);
    }
    const periodStart = context.currentPeriodStart ?? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [usage, activeCalls] = await Promise.all([
      CallDetailRecordModel.aggregate<{ seconds: number }>([
        { $match: { ownerId: orgId, createdAt: { $gte: periodStart } } },
        { $group: { _id: null, seconds: { $sum: "$durationSeconds" } } },
      ]),
      CallDetailRecordModel.countDocuments({
        ownerId: orgId,
        status: { $in: ["initiated", "ringing", "active"] },
      }),
    ]);
    const monthlyMinutes = limitValue(context, "monthlyMinutes");
    if ((usage[0]?.seconds ?? 0) >= monthlyMinutes * 60) {
      throw new HttpError(402, `Monthly call allowance of ${monthlyMinutes} minutes has been reached.`);
    }
    const includedOnly = context.usagePricing.mode === "included_only";
    const overageEnabled = context.usagePricing.overageEnabled !== false;
    const includedMinutes = Math.max(0, Number(context.allowances.includedMinutes ?? 0));
    if (includedOnly && !overageEnabled && (usage[0]?.seconds ?? 0) >= includedMinutes * 60) {
      throw new HttpError(402, `Included call allowance of ${includedMinutes} minutes has been reached. Contact your provider to change plans.`);
    }
    const concurrency = limitValue(context, "concurrentCalls");
    if (activeCalls >= concurrency) {
      throw new HttpError(429, `Organization concurrency limit of ${concurrency} has been reached.`);
    }
    next();
  } catch (error) {
    next(error);
  }
}
