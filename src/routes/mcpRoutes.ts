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
import { isValidObjectId, startSession } from "mongoose";
import { AutomationModel, AutomationVersionModel } from "../models/Automation.js";
import { WhatsAppContactGroupModel, WhatsAppTemplateModel } from "../models/WhatsAppEntities.js";
import { WhiteLabelSubscriptionModel } from "../models/WhiteLabelSubscription.js";
import { draftSchema, findOwnedAutomation, graphSchema, validateAutomation } from "../services/automationDefinitionService.js";

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
      OrganizationMemberModel.findOne({ userId: record.userId, orgId: record.organizationId }).select("role").lean(),
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
      extra: { userId: record.userId, organizationId: record.organizationId, role: membership.role },
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
  const canWrite = context.authInfo?.scopes.includes("vozon:write") && ["owner", "admin"].includes(String(context.authInfo?.extra?.role ?? ""));
  const userId = String(context.authInfo?.extra?.userId ?? "");
  const writeDenied = () => ({ isError: true as const, content: [{ type: "text" as const, text: "Reconnect Claude with Vozon write access as a workspace owner or admin." }] });

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
    async (args) => canWrite
      ? { content: [{ type: "text" as const, text: JSON.stringify(await runAssistantTool(organizationId, "create_agent", JSON.stringify(args))) }] }
      : { isError: true, content: [{ type: "text" as const, text: "Only workspace owners and admins can create voice agents." }] },
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
    async (args) => canWrite
      ? { content: [{ type: "text" as const, text: JSON.stringify(await runAssistantTool(organizationId, "update_agent", JSON.stringify(args))) }] }
      : { isError: true, content: [{ type: "text" as const, text: "Only workspace owners and admins can update voice agents." }] },
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

  server.registerTool(
    "list_campaigns",
    {
      description: "List recent outbound campaigns and their status in the connected workspace.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await runAssistantTool(organizationId, "list_campaigns", "{}")) }] }),
  );

  server.registerTool(
    "get_campaign_performance",
    {
      description: "Analyze lead outcomes, call statuses and failure reasons for a campaign. Defaults to the latest campaign.",
      inputSchema: z.object({ campaignNameOrId: z.string().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await runAssistantTool(organizationId, "get_campaign_performance", JSON.stringify(args))) }] }),
  );

  server.registerTool(
    "get_follow_up_candidates",
    {
      description: "Find campaign contacts needing follow-up review, excluding scheduled callbacks and verified conversions. This tool never schedules a call.",
      inputSchema: z.object({ campaignNameOrId: z.string().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await runAssistantTool(organizationId, "get_follow_up_candidates", JSON.stringify(args))) }] }),
  );

  server.registerTool(
    "get_agent_performance",
    {
      description: "Review a voice agent's call results, latency and failure reasons over a recent day range.",
      inputSchema: z.object({ agentNameOrId: z.string(), days: z.number().int().min(1).max(90).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await runAssistantTool(organizationId, "get_agent_performance", JSON.stringify(args))) }] }),
  );

  server.registerTool(
    "search_agent_knowledge",
    {
      description: "Search indexed knowledge sources for a voice agent, returning short cited excerpts.",
      inputSchema: z.object({ agentNameOrId: z.string(), query: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await runAssistantTool(organizationId, "search_agent_knowledge", JSON.stringify(args))) }] }),
  );

  server.registerTool("list_automations", {
    description: "List workflows in this workspace, including status and revision.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => ({ content: [{ type: "text", text: JSON.stringify(await AutomationModel.find({ ownerId: organizationId }).select("name description status revision publishedVersion updatedAt").sort({ updatedAt: -1 }).limit(100).lean()) }] }));

  server.registerTool("list_whatsapp_templates", {
    description: "List this workspace's WhatsApp templates and approval status for use in automation drafts.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => ({ content: [{ type: "text", text: JSON.stringify(await WhatsAppTemplateModel.find({ ownerId: organizationId }).select("name language status category bodyText").sort({ updatedAt: -1 }).limit(100).lean()) }] }));

  server.registerTool("list_contact_groups", {
    description: "List WhatsApp contact groups and counts in this workspace. Does not send messages.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => ({ content: [{ type: "text", text: JSON.stringify(await WhatsAppContactGroupModel.find({ ownerId: organizationId }).select("name description contactCount").sort({ name: 1 }).limit(100).lean()) }] }));

  server.registerTool("get_automation", {
    description: "Inspect a workflow draft graph so it can be edited safely.",
    inputSchema: z.object({ automationId: z.string() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ automationId }) => {
    if (!isValidObjectId(automationId)) return { isError: true, content: [{ type: "text" as const, text: "Invalid workflow ID." }] };
    const flow = await findOwnedAutomation(organizationId, automationId);
    return { content: [{ type: "text" as const, text: JSON.stringify({ id: flow.id, name: flow.name, description: flow.description, status: flow.status, revision: flow.revision, draft: flow.draft, publishedVersion: flow.publishedVersion }) }] };
  });

  server.registerTool("create_automation", {
    description: "Create a workflow draft from a graph of trigger, action, decision, and end nodes. Drafts do not run until published.",
    inputSchema: draftSchema.omit({ revision: true }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args) => {
    if (!canWrite) return writeDenied();
    const subscription = await WhiteLabelSubscriptionModel.findOne({ orgId: organizationId }).sort({ createdAt: -1 }).select("status").lean();
    if (subscription && !["active", "trialing"].includes(subscription.status)) {
      return { isError: true, content: [{ type: "text" as const, text: "This workspace subscription does not allow creating workflows." }] };
    }
    const draft = draftSchema.parse(args);
    const issues = await validateAutomation(organizationId, draft.graph);
    const flow = await AutomationModel.create({ ownerId: organizationId, name: draft.name, description: draft.description, draft: draft.graph, createdBy: userId });
    return { content: [{ type: "text" as const, text: JSON.stringify({ id: flow.id, name: flow.name, status: flow.status, revision: flow.revision, issues }) }] };
  });

  server.registerTool("update_automation", {
    description: "Replace a workflow draft graph using its current revision. Does not publish or start the workflow.",
    inputSchema: draftSchema.extend({ automationId: z.string(), revision: z.number().int().min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ automationId, ...args }) => {
    if (!canWrite) return writeDenied();
    if (!isValidObjectId(automationId)) return { isError: true, content: [{ type: "text" as const, text: "Invalid workflow ID." }] };
    const subscription = await WhiteLabelSubscriptionModel.findOne({ orgId: organizationId }).sort({ createdAt: -1 }).select("status").lean();
    if (subscription && !["active", "trialing"].includes(subscription.status)) {
      return { isError: true, content: [{ type: "text" as const, text: "This workspace subscription does not allow updating workflows." }] };
    }
    const draft = draftSchema.parse(args);
    const flow = await AutomationModel.findOneAndUpdate({ _id: automationId, ownerId: organizationId, revision: draft.revision }, { $set: { name: draft.name, description: draft.description, draft: draft.graph }, $inc: { revision: 1 } }, { new: true, runValidators: true });
    if (!flow) return { isError: true, content: [{ type: "text" as const, text: "Workflow not found or revision changed. Read it again before updating." }] };
    const issues = await validateAutomation(organizationId, draft.graph);
    return { content: [{ type: "text" as const, text: JSON.stringify({ id: flow.id, name: flow.name, revision: flow.revision, issues }) }] };
  });

  server.registerTool("publish_automation", {
    description: "Publish and activate a validated workflow. This may automatically call or message contacts when its trigger occurs. Use only after the user explicitly asks to activate this specific workflow.",
    inputSchema: z.object({ automationId: z.string(), confirmPublish: z.literal(true) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ automationId }) => {
    if (!canWrite) return writeDenied();
    if (!isValidObjectId(automationId)) return { isError: true, content: [{ type: "text" as const, text: "Invalid workflow ID." }] };
    const flow = await findOwnedAutomation(organizationId, automationId);
    const subscription = await WhiteLabelSubscriptionModel.findOne({ orgId: organizationId }).sort({ createdAt: -1 }).select("status featuresSnapshot").lean();
    if (subscription && !["active", "trialing"].includes(subscription.status)) return { isError: true, content: [{ type: "text" as const, text: "This workspace subscription does not allow publishing workflows." }] };
    const issues = await validateAutomation(organizationId, graphSchema.parse(flow.draft), subscription?.featuresSnapshot as Record<string, unknown> | undefined, true);
    if (issues.length) return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ message: "Resolve workflow checks before publishing.", issues }) }] };
    const dbSession = await startSession();
    try {
      await dbSession.withTransaction(async () => {
        const updated = await AutomationModel.findOneAndUpdate({ _id: flow._id, ownerId: organizationId, revision: flow.revision, publishedVersion: flow.publishedVersion }, { $set: { status: "live", published: flow.draft, publishedAt: new Date(), publishedBy: userId, triggerCursor: "" }, $inc: { publishedVersion: 1 } }, { new: true, session: dbSession });
        if (!updated) throw new Error("Workflow changed while publishing. Read it again and retry.");
        await AutomationVersionModel.create([{ ownerId: organizationId, automationId: flow._id, version: flow.publishedVersion + 1, graph: flow.draft, name: flow.name, publishedBy: userId }], { session: dbSession });
      });
    } finally { await dbSession.endSession(); }
    return { content: [{ type: "text" as const, text: JSON.stringify({ id: automationId, status: "live", publishedVersion: flow.publishedVersion + 1 }) }] };
  });

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
  scopesSupported: ["vozon:read", "vozon:write"],
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
