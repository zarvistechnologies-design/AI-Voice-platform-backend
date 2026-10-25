import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";

import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { McpOAuthAuthorizationRequestModel } from "../models/McpOAuthAuthorizationRequest.js";
import { McpOAuthClientModel } from "../models/McpOAuthClient.js";
import { McpOAuthTokenModel } from "../models/McpOAuthToken.js";
import { HttpError } from "../utils/httpError.js";

const allowedScopes = ["vozon:read"] as const;
const codeLifetimeMs = 5 * 60_000;
const accessLifetimeSeconds = 60 * 60;
const refreshLifetimeMs = 30 * 24 * 60 * 60_000;

export const STATIC_CLAUDE_CLIENT_ID = "vozon_claude_connector";
export const CLAUDE_REDIRECT_URL = "https://claude.ai/api/mcp/oauth_callback";

export function getMcpServerUrl() {
  const url = new URL(env.mcpServerUrl);
  if (env.nodeEnv === "production" && url.protocol !== "https:") {
    throw new Error("MCP_SERVER_URL must use HTTPS in production.");
  }
  return url;
}

export function getBaseUrlFromRequest(request?: Request): string {
  if (request) {
    const forwardedProto = (request.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
    const forwardedHost = (request.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
    const host = forwardedHost || request.headers.host;
    if (host) {
      const isHttps = request.secure || forwardedProto === "https" || host.includes("vozon.ai") || host.includes("onrender.com") || host.includes("anthropic");
      return `${isHttps ? "https" : "http"}://${host}`.replace(/\/$/, "");
    }
  }
  return getMcpServerUrl().origin;
}

export function getMcpAuthorizationMetadata(request?: Request) {
  const base = getBaseUrlFromRequest(request);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...allowedScopes],
    client_id_metadata_document_supported: false,
  };
}

export function getMcpProtectedResourceMetadata(request?: Request) {
  const base = getBaseUrlFromRequest(request);
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: [...allowedScopes],
    resource_name: "Vozon",
  };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function newSecret() {
  return randomBytes(32).toString("base64url");
}

function isSafeRedirectUri(value: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol === "claude:" || url.protocol === "claude-desktop:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return value.startsWith("claude://") || value.startsWith("claude-desktop://");
  }
}

function isClaudeRedirectUri(value: string) {
  try {
    const url = new URL(value);
    return (
      url.hostname === "claude.ai" ||
      url.hostname.endsWith(".claude.ai") ||
      url.hostname.endsWith(".anthropic.com") ||
      url.protocol === "claude:" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return value.startsWith("claude://") || value.startsWith("claude-desktop://");
  }
}

function safeRedirect(client: { clientId?: string; redirectUris: string[] }, value: string) {
  if (client.clientId === STATIC_CLAUDE_CLIENT_ID && (isClaudeRedirectUri(value) || isSafeRedirectUri(value))) {
    return true;
  }
  if (isClaudeRedirectUri(value)) {
    return true;
  }
  return client.redirectUris.includes(value) && isSafeRedirectUri(value);
}

export async function ensureStaticClaudeClient(clientId?: string) {
  const targetId = clientId || STATIC_CLAUDE_CLIENT_ID;
  const existing = await McpOAuthClientModel.findOne({ clientId: targetId }).lean();
  if (!existing) {
    await McpOAuthClientModel.create({
      clientId: targetId,
      clientName: "Claude MCP Connector",
      redirectUris: [
        "https://claude.ai/api/mcp/oauth_callback",
        "https://claude.ai/oauth/callback",
        "http://localhost:5173/oauth/callback",
        "http://localhost:3000/oauth/callback",
      ],
    });
  }
}

function authorizationError(redirectUri: string, state: string | undefined, error: string, description: string) {
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("error", error);
  redirect.searchParams.set("error_description", description);
  if (state) redirect.searchParams.set("state", state);
  return redirect.href;
}

export async function registerMcpOAuthClient(request: Request, response: Response) {
  const rawBody = (request.body || {}) as Record<string, unknown>;
  const rawRedirectUris = rawBody.redirect_uris ?? rawBody.redirect_uri;
  let redirectUris: string[] = [];
  if (Array.isArray(rawRedirectUris)) {
    redirectUris = rawRedirectUris.map((u) => String(u).trim()).filter(Boolean);
  } else if (typeof rawRedirectUris === "string" && rawRedirectUris.trim()) {
    redirectUris = [rawRedirectUris.trim()];
  }

  if (redirectUris.length === 0) {
    redirectUris = [CLAUDE_REDIRECT_URL];
  }

  const clientId = newSecret();
  const clientName = typeof rawBody.client_name === "string" && rawBody.client_name.trim()
    ? rawBody.client_name.trim()
    : "Claude MCP Connector";

  const dedupedRedirectUris = [...new Set(redirectUris)];
  await McpOAuthClientModel.create({ clientId, clientName, redirectUris: dedupedRedirectUris });

  response.status(201).json({
    client_id: clientId,
    client_name: clientName,
    redirect_uris: dedupedRedirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    client_id_issued_at: Math.floor(Date.now() / 1000),
  });
}

export async function beginMcpAuthorization(request: Request, response: Response) {
  const clientId = String(request.query.client_id ?? "").trim();
  const redirectUri = String(request.query.redirect_uri ?? "").trim();
  const state = typeof request.query.state === "string" ? request.query.state : undefined;

  if (clientId === STATIC_CLAUDE_CLIENT_ID || clientId.toLowerCase().startsWith("vozon_claude")) {
    await ensureStaticClaudeClient(clientId);
  }

  let client = await McpOAuthClientModel.findOne({ clientId }).select("clientId clientName redirectUris").lean();
  if (!client && (isClaudeRedirectUri(redirectUri) || clientId.includes("claude"))) {
    await ensureStaticClaudeClient(clientId);
    client = await McpOAuthClientModel.findOne({ clientId }).select("clientId clientName redirectUris").lean();
  }

  if (!client || !safeRedirect(client, redirectUri)) {
    response.status(400).json({ error: "invalid_request", error_description: "Unknown client or redirect URL." });
    return;
  }

  const responseType = request.query.response_type;
  const challenge = String(request.query.code_challenge ?? "");
  const challengeMethod = String(request.query.code_challenge_method ?? "");
  const rawResource = String(request.query.resource ?? "").trim().replace(/\/$/, "");
  const base = getBaseUrlFromRequest(request);
  const expectedResource = `${base}/mcp`;
  const resource = rawResource || expectedResource;

  if (
    responseType !== "code" ||
    !challenge ||
    (challengeMethod && challengeMethod !== "S256")
  ) {
    response.redirect(302, authorizationError(redirectUri, state, "invalid_request", "The authorization request is missing required PKCE or response_type values."));
    return;
  }

  const authorizationRequest = await McpOAuthAuthorizationRequestModel.create({
    clientId,
    redirectUri,
    codeChallenge: challenge,
    state: state || newSecret(),
    scopes: [...allowedScopes],
    resource,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const consentUrl = new URL("/dashboard/assistant/claude-consent", env.clientUrl);
  consentUrl.searchParams.set("request_id", String(authorizationRequest._id));
  response.redirect(302, consentUrl.href);
}

export async function getMcpConsent(request: AuthenticatedRequest, response: Response) {
  if (!request.organization) throw new HttpError(401, "Sign in to connect Claude.");
  const requestId = String(request.query.request_id ?? "");
  const pending = await McpOAuthAuthorizationRequestModel.findOne({
    _id: requestId,
    status: "pending",
    expiresAt: { $gt: new Date() },
  }).select("clientId scopes").lean();
  if (!pending) throw new HttpError(404, "This Claude connection request has expired. Start the connection again.");
  const client = await McpOAuthClientModel.findOne({ clientId: pending.clientId }).select("clientName").lean();
  response.json({ clientName: client?.clientName || "MCP client", workspaceName: request.organization.name, scopes: pending.scopes });
}

const consentSchema = z.object({ requestId: z.string().min(1).max(100), approved: z.boolean() }).strict();

export async function respondToMcpConsent(request: AuthenticatedRequest, response: Response) {
  if (!request.user || !request.organization) throw new HttpError(401, "Sign in to connect Claude.");
  const parsed = consentSchema.safeParse(request.body);
  if (!parsed.success) throw new HttpError(400, "Choose whether to approve this connection.");

  const pending = await McpOAuthAuthorizationRequestModel.findOne({
    _id: parsed.data.requestId,
    status: "pending",
    expiresAt: { $gt: new Date() },
  }).select("clientId redirectUri state scopes codeChallenge resource");
  if (!pending) throw new HttpError(404, "This Claude connection request has expired. Start the connection again.");

  const update = await McpOAuthAuthorizationRequestModel.updateOne(
    { _id: pending._id, status: "pending", expiresAt: { $gt: new Date() } },
    {
      $set: {
        status: parsed.data.approved ? "approved" : "denied",
        userId: parsed.data.approved ? request.user.id : "",
        organizationId: parsed.data.approved ? request.organization.id : "",
      },
    },
  );
  if (update.modifiedCount !== 1) throw new HttpError(409, "This connection request has already been handled.");

  if (!parsed.data.approved) {
    response.json({ redirectUrl: authorizationError(pending.redirectUri, pending.state, "access_denied", "The user declined Vozon access.") });
    return;
  }

  const code = newSecret();
  await McpOAuthAuthorizationRequestModel.updateOne({ _id: pending._id, status: "approved" }, { $set: { codeHash: hash(code), expiresAt: new Date(Date.now() + codeLifetimeMs) } });
  const callback = new URL(pending.redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", pending.state);
  response.json({ redirectUrl: callback.href });
}

export async function issueMcpOAuthToken(request: Request, response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  const body = request.body as Record<string, unknown> | undefined;
  const grantType = String(body?.grant_type ?? "");
  const clientId = String(body?.client_id ?? "").trim();
  if (!clientId) {
    response.status(400).json({ error: "invalid_client" });
    return;
  }

  if (clientId === STATIC_CLAUDE_CLIENT_ID || clientId.toLowerCase().startsWith("vozon_claude")) {
    await ensureStaticClaudeClient(clientId);
  } else if (!await McpOAuthClientModel.exists({ clientId })) {
    response.status(400).json({ error: "invalid_client" });
    return;
  }

  const accessToken = newSecret();
  const refreshToken = newSecret();
  const accessExpiresAt = new Date(Date.now() + accessLifetimeSeconds * 1000);
  const refreshExpiresAt = new Date(Date.now() + refreshLifetimeMs);

  if (grantType === "authorization_code") {
    const code = String(body?.code ?? "");
    const redirectUri = String(body?.redirect_uri ?? "");
    const verifier = String(body?.code_verifier ?? "");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      response.status(400).json({ error: "invalid_grant" });
      return;
    }
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const pending = await McpOAuthAuthorizationRequestModel.findOneAndUpdate(
      {
        clientId,
        redirectUri,
        codeHash: hash(code),
        codeChallenge: challenge,
        status: "approved",
        expiresAt: { $gt: new Date() },
      },
      { $set: { status: "exchanged", codeHash: "" } },
      { new: true },
    ).select("userId organizationId scopes resource");
    if (!pending?.userId || !pending.organizationId) {
      response.status(400).json({ error: "invalid_grant" });
      return;
    }
    await McpOAuthTokenModel.create({
      clientId,
      userId: pending.userId,
      organizationId: pending.organizationId,
      scopes: pending.scopes,
      accessTokenHash: hash(accessToken),
      accessExpiresAt,
      refreshTokenHash: hash(refreshToken),
      refreshExpiresAt,
    });
  } else if (grantType === "refresh_token") {
    const currentRefreshToken = String(body?.refresh_token ?? "");
    const result = await McpOAuthTokenModel.findOneAndUpdate(
      {
        clientId,
        refreshTokenHash: hash(currentRefreshToken),
        refreshExpiresAt: { $gt: new Date() },
        revokedAt: { $exists: false },
      },
      {
        $set: {
          accessTokenHash: hash(accessToken),
          accessExpiresAt,
          refreshTokenHash: hash(refreshToken),
          refreshExpiresAt,
        },
      },
      { new: true },
    ).select("_id");
    if (!result) {
      response.status(400).json({ error: "invalid_grant" });
      return;
    }
  } else {
    response.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: accessLifetimeSeconds,
    refresh_token: refreshToken,
    scope: "vozon:read",
  });
}

export async function revokeMcpOAuthToken(request: Request, response: Response) {
  const token = String((request.body as Record<string, unknown> | undefined)?.token ?? "");
  if (token) await McpOAuthTokenModel.updateOne(
    { $or: [{ accessTokenHash: hash(token) }, { refreshTokenHash: hash(token) }] },
    { $set: { revokedAt: new Date() } },
  );
  response.status(200).end();
}

export async function mcpConnectionStatus(request: AuthenticatedRequest, response: Response) {
  if (!request.user || !request.organization) throw new HttpError(401, "Authentication required.");
  const connections = await McpOAuthTokenModel.aggregate([
    { $match: { userId: request.user.id, organizationId: request.organization.id, revokedAt: { $exists: false }, refreshExpiresAt: { $gt: new Date() } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$clientId", connectedAt: { $first: "$createdAt" } } },
    { $limit: 20 },
  ]);
  const clients = await McpOAuthClientModel.find({ clientId: { $in: connections.map((item) => item._id) } }).select("clientId clientName").lean();
  const clientNames = new Map(clients.map((client) => [client.clientId, client.clientName]));
  const dynamicBase = getBaseUrlFromRequest(request);
  response.json({
    serverUrl: `${dynamicBase}/mcp`,
    staticClientId: STATIC_CLAUDE_CLIENT_ID,
    connections: connections.map((connection) => ({ clientId: connection._id, clientName: clientNames.get(connection._id) || "Claude", connectedAt: connection.connectedAt })),
  });
}

export async function disconnectMcpClient(request: AuthenticatedRequest, response: Response) {
  if (!request.user || !request.organization) throw new HttpError(401, "Authentication required.");
  const clientId = String(request.params.clientId ?? "");
  await McpOAuthTokenModel.updateMany(
    { clientId, userId: request.user.id, organizationId: request.organization.id, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
  response.status(204).end();
}
