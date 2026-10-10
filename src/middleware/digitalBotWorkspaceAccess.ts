import type { NextFunction, Response } from "express";
import { isValidObjectId } from "mongoose";

import type { AuthenticatedRequest } from "./auth.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { CampaignModel } from "../models/Campaign.js";
import { DigitalBotAgentConnectionModel } from "../models/DigitalBotAgentConnection.js";
import { OrganizationModel } from "../models/Organization.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { HttpError } from "../utils/httpError.js";

function pathId(path: string, resource: "campaigns" | "calls" | "call-logs" | "agents") {
  const match = path.match(new RegExp(`^/${resource}/([a-fA-F0-9]{24})(?:/|$)`));
  return match?.[1] ?? "";
}

async function targetFromRequest(request: AuthenticatedRequest) {
  const bodyAgentId = typeof request.body?.agentId === "string" ? request.body.agentId.trim() : "";
  const queryAgentId = typeof request.query.agentId === "string" ? request.query.agentId.trim() : "";
  const pathAgentId = pathId(request.path, "agents");
  const agentId = bodyAgentId || queryAgentId || pathAgentId;
  if (agentId) return { agentId, ownerId: "" };

  const campaignId = pathId(request.path, "campaigns");
  if (campaignId) {
    const campaign = await CampaignModel.findById(campaignId).select("ownerId agentId").lean();
    return campaign ? { ownerId: campaign.ownerId, agentId: String(campaign.agentId) } : null;
  }

  const callId = pathId(request.path, "calls") || pathId(request.path, "call-logs");
  if (callId) {
    const call = await CallDetailRecordModel.findById(callId).select("ownerId agentId").lean();
    return call ? { ownerId: call.ownerId, agentId: String(call.agentId) } : null;
  }
  return null;
}

export async function resolveConnectedDigitalBotWorkspace(
  request: AuthenticatedRequest,
  _response: Response,
  next: NextFunction,
) {
  try {
    if (request.apiKey?.workspaceAccess !== "connected-digitalbot" || !request.organization) {
      next();
      return;
    }
    const target = await targetFromRequest(request);
    if (!target) {
      next();
      return;
    }
    if (!isValidObjectId(target.agentId)) throw new HttpError(400, "Valid agentId is required.");
    if (target.ownerId && String(target.ownerId) === request.organization.id) {
      next();
      return;
    }
    if (!target.ownerId) {
      const belongsToApiKeyWorkspace = await VoiceAgentModel.exists({
        _id: target.agentId,
        ownerId: request.organization.id,
      });
      if (belongsToApiKeyWorkspace) {
        next();
        return;
      }
    }
    const connection = await DigitalBotAgentConnectionModel.findOne({
      ...(target.ownerId ? { ownerId: target.ownerId } : {}),
      targetAgentId: target.agentId,
      status: "connected",
    }).select("ownerId").lean();
    if (!connection) throw new HttpError(403, "This Vozon agent is not connected to a DigitalBot workspace.");
    if (connection.ownerId === request.organization.id) {
      next();
      return;
    }
    const organization = await OrganizationModel.findById(connection.ownerId)
      .select("name slug lifecycleStatus")
      .lean();
    if (!organization || organization.lifecycleStatus === "suspended" || organization.lifecycleStatus === "archived") {
      throw new HttpError(403, "The connected Vozon workspace is not active.");
    }
    request.organization = {
      ...request.organization,
      id: String(organization._id),
      name: organization.name,
      slug: organization.slug,
      role: "member",
    };
    next();
  } catch (error) {
    next(error);
  }
}
