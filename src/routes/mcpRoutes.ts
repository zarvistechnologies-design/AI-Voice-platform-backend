import { Router, type Request, type Response } from "express";
import { McpServer, OAuthError, createMcpHandler, getOAuthProtectedResourceMetadataUrl, type AuthInfo, type McpRequestContext, type OAuthMetadata, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { mcpAuthMetadataRouter, requireBearerAuth } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";

import {
  beginMcpAuthorization,
  disconnectMcpClient,
  getMcpAuthorizationMetadata,
  getMcpConsent,
  getMcpProtectedResourceMetadata,
  getMcpServerUrl,
  issueMcpOAuthToken,
  mcpConnectionStatus,
  registerMcpOAuthClient,
  respondToMcpConsent,
  revokeMcpOAuthToken,
} from "../controllers/mcpOAuthController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rateLimit.js";
import { McpOAuthTokenModel } from "../models/McpOAuthToken.js";
import { OrganizationMemberModel } from "../models/OrganizationMember.js";
import { OrganizationModel } from "../models/Organization.js";
import { runAssistantTool } from "../services/assistantToolService.js";
import { createHash } from "node:crypto";

const resourceUrl = getMcpServerUrl();
const oauthMetadata = getMcpAuthorizationMetadata() as OAuthMetadata;

const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await McpOAuthTokenModel.findOne({
      accessTokenHash: createTokenHash(token),
      accessExpiresAt: { $gt: new Date() },
      revokedAt: { $exists: false },
    }).select("clientId userId organizationId scopes accessExpiresAt").lean();
    if (!record) throw new OAuthError("invalid_token", "The Vozon access token is invalid or expired.");

    const [membership, organization] = await Promise.all([
      OrganizationMemberModel.exists({ userId: record.userId, orgId: record.organizationId }),
      OrganizationModel.findById(record.organizationId).select("lifecycleStatus whiteLabelAccountId").lean(),
    ]);
    if (!membership || !organization || organization.lifecycleStatus === "suspended" || organization.lifecycleStatus === "archived") {
      throw new OAuthError("invalid_token", "The Vozon workspace access for this token is no longer active.");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.accessExpiresAt.getTime() / 1000),
      resource: resourceUrl,
      extra: { userId: record.userId, organizationId: record.organizationId },
    };
  },
};

function createTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const authorizationMiddleware = requireBearerAuth({
  verifier,
  requiredScopes: ["vozon:read"],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  expectedResource: resourceUrl,
});

const mcpHandler = createMcpHandler((context: McpRequestContext) => {
  const server = new McpServer({ name: "vozon", version: "1.0.0" });
  const organizationId = String(context.authInfo?.extra?.organizationId ?? "");

  server.registerTool(
    "list_agents",
    {
      description: "List the voice agents in the connected Vozon workspace with their status, language, voice, and assigned phone.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(await runAssistantTool(organizationId, "list_agents", "{}")) }],
    }),
  );

  server.registerTool(
    "get_agent_details",
    {
      description: "Inspect the complete configuration of a specific voice agent, including its system prompt, greeting (firstMessage), voice, language, status, and assigned phone number.",
      inputSchema: z.object({
        agentNameOrId: z.string().describe("The name or ID of the voice agent to inspect."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ agentNameOrId }) => ({
      content: [{ type: "text", text: JSON.stringify(await runAssistantTool(organizationId, "get_agent_details", JSON.stringify({ agentNameOrId }))) }],
    }),
  );

  server.registerTool(
    "create_agent",
    {
      description: "Create a new voice agent in this workspace.",
      inputSchema: z.object({
        name: z.string().describe("Name of the agent (e.g. 'Customer Support', 'Booking Assistant')."),
        prompt: z.string().optional().describe("System instructions or behavioral prompt for the voice agent."),
        firstMessage: z.string().optional().describe("First greeting the agent speaks when answering a call."),
        language: z.string().optional().describe("Language for the voice agent (e.g. 'English', 'Hindi')."),
        team: z.string().optional().describe("Team name."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(await runAssistantTool(organizationId, "create_agent", JSON.stringify(args))) }],
    }),
  );

  server.registerTool(
    "update_agent",
    {
      description: "Update the configuration of an existing voice agent (modify prompt, greeting, status, or language).",
      inputSchema: z.object({
        agentNameOrId: z.string().describe("The name or ID of the voice agent to update."),
        prompt: z.string().optional().describe("Updated system instructions/prompt."),
        firstMessage: z.string().optional().describe("Updated greeting."),
        language: z.string().optional().describe("Updated language."),
        status: z.enum(["Live", "Draft", "Paused"]).optional().describe("Updated status."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(await runAssistantTool(organizationId, "update_agent", JSON.stringify(args))) }],
    }),
  );

  server.registerTool(
    "get_recent_calls",
    {
      description: "Retrieve recent individual calls from the connected workspace, including callId, status, duration, failure reasons, and preview.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(15).describe("Number of recent calls to return (1-50)."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ limit }) => ({
      content: [{ type: "text", text: JSON.stringify(await runAssistantTool(organizationId, "get_recent_calls", JSON.stringify({ limit }))) }],
    }),
  );

  server.registerTool(
    "get_call_summary",
    {
      description: "Get aggregate call totals over a calendar number of DAYS for the connected Vozon workspace.",
      inputSchema: z.object({ days: z.number().int().min(1).max(90).default(7) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ days }) => ({
      content: [{ type: "text", text: JSON.stringify(await runAssistantTool(organizationId, "get_call_summary", JSON.stringify({ days }))) }],
    }),
  );

  server.registerTool(
    "get_call_transcript",
    {
      description: "Retrieve the full verbatim conversation transcript of a call (turn-by-turn dialog between caller and voice agent), along with duration, sentiment, recording URL, and caller phone number. If callId is omitted, it retrieves the most recent call with a transcript.",
      inputSchema: z.object({
        callId: z.string().optional().describe("Optional call ID or room name. If omitted, the latest call with a transcript is returned."),
        agentName: z.string().optional().describe("Optional agent name to find the latest call for."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(await runAssistantTool(organizationId, "get_call_transcript", JSON.stringify(args))) }],
    }),
  );

  server.registerTool(
    "get_call_details",
    {
      description: "Retrieve technical diagnostics and metrics for a specific call (or latest call), including latency (P50/P90), cost breakdown, error messages, SIP termination codes, and recording URL.",
      inputSchema: z.object({
        callId: z.string().optional().describe("Optional call ID. If omitted, details for the latest call are returned."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(await runAssistantTool(organizationId, "get_call_details", JSON.stringify(args))) }],
    }),
  );

  server.registerTool(
    "list_phone_numbers",
    {
      description: "List all active, pending, or configured phone numbers in the connected workspace, showing their assigned voice agents, provider, and monthly fee.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(await runAssistantTool(organizationId, "list_phone_numbers", "{}")) }],
    }),
  );

  return server;
});
const nodeHandler = toNodeHandler(mcpHandler);

export const oauthRouter = Router();
const registrationLimit = createRateLimit({ windowMs: 60 * 60_000, max: 300, message: "Too many OAuth client registrations. Try again later." });
const oauthTokenLimit = createRateLimit({ windowMs: 60_000, max: 60, message: "Too many OAuth requests. Try again shortly." });
oauthRouter.post("/register", registrationLimit, asyncHandler(registerMcpOAuthClient));
oauthRouter.get("/authorize", oauthTokenLimit, asyncHandler(beginMcpAuthorization));
oauthRouter.post("/token", oauthTokenLimit, asyncHandler(issueMcpOAuthToken));
oauthRouter.post("/revoke", oauthTokenLimit, asyncHandler(revokeMcpOAuthToken));

export const mcpMetadataRouter = mcpAuthMetadataRouter({
  oauthMetadata,
  resourceServerUrl: resourceUrl,
  scopesSupported: ["vozon:read"],
  resourceName: "Vozon",
});

export const mcpHttpRouter = Router();
mcpHttpRouter.all("/", authorizationMiddleware, (request: Request, response: Response) => {
  void nodeHandler(request, response, request.body);
});

export const mcpConsentApiRouter = Router();
mcpConsentApiRouter.get("/metadata", (_request, response) => response.json({ ...getMcpProtectedResourceMetadata(), authorization_server: getMcpAuthorizationMetadata().issuer }));
mcpConsentApiRouter.get("/consent", requireAuth, asyncHandler(getMcpConsent));
mcpConsentApiRouter.post("/consent", requireAuth, asyncHandler(respondToMcpConsent));
mcpConsentApiRouter.get("/connections", requireAuth, asyncHandler(mcpConnectionStatus));
mcpConsentApiRouter.delete("/connections/:clientId", requireAuth, asyncHandler(disconnectMcpClient));
