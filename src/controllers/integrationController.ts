import type { Response } from "express";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import {
  connectNativeIntegration,
  disconnectNativeIntegration,
  nativeProviders,
  type NativeProvider,
} from "../services/integrationService.js";
import { HttpError } from "../utils/httpError.js";

function orgId(request: AuthenticatedRequest) {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

function provider(value: string): NativeProvider {
  if (nativeProviders.includes(value as NativeProvider)) return value as NativeProvider;
  throw new HttpError(404, "Integration provider not found.");
}

export async function listIntegrations(request: AuthenticatedRequest, response: Response) {
  const integrations = await ProviderIntegrationModel.find({ ownerId: orgId(request) }).sort({ provider: 1 });
  response.json({
    providers: ["vobiz", ...nativeProviders].map((id) => {
      const integration = integrations.find((item) => item.provider === id);
      return {
        id,
        connected: integration?.status === "connected",
        accountId: integration?.accountId ?? "",
        status: integration?.status ?? "disconnected",
        lastVerifiedAt: integration?.lastVerifiedAt ?? null,
        metadata: integration?.metadata ?? {},
      };
    }),
  });
}

export async function connectIntegration(request: AuthenticatedRequest, response: Response) {
  const integration = await connectNativeIntegration(
    orgId(request),
    provider(request.params.provider),
    typeof request.body.credential === "string" ? request.body.credential : "",
  );
  response.json({
    id: integration.provider,
    connected: true,
    accountId: integration.accountId,
    status: integration.status,
    lastVerifiedAt: integration.lastVerifiedAt,
    metadata: integration.metadata,
  });
}

export async function disconnectIntegration(request: AuthenticatedRequest, response: Response) {
  await disconnectNativeIntegration(orgId(request), provider(request.params.provider));
  response.status(204).end();
}
