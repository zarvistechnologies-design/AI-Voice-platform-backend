import type { Response } from "express";
import { isValidObjectId } from "mongoose";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { RemoteMcpConnectionModel } from "../models/RemoteMcpConnection.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { attachedMcpToolName, discoverRemoteMcpTools, remoteMcpFailureMessage, validateRemoteMcpUrl, type RemoteMcpTool } from "../services/remoteMcpService.js";
import { invalidateDashboardCache } from "../services/dashboardCacheService.js";
import { decryptSecret, encryptSecret } from "../utils/secretCrypto.js";
import { HttpError } from "../utils/httpError.js";

function ownerId(request: AuthenticatedRequest) {
  if (!request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

function connectionId(request: AuthenticatedRequest) {
  const id = String(request.params.connectionId ?? "");
  if (!isValidObjectId(id)) throw new HttpError(404, "MCP connection not found.");
  return id;
}

function safeConnection(connection: {
  _id: unknown; name: string; provider: string; urlOrigin: string; status: string;
  lastVerifiedAt?: Date | null; lastError?: string; tools?: unknown[];
}) {
  return {
    id: String(connection._id), name: connection.name, provider: connection.provider,
    url: connection.urlOrigin, status: connection.status, lastVerifiedAt: connection.lastVerifiedAt ?? null,
    lastError: connection.lastError ?? "", tools: connection.tools ?? [],
  };
}

export async function listRemoteMcpConnections(request: AuthenticatedRequest, response: Response) {
  const [connections, agents] = await Promise.all([
    RemoteMcpConnectionModel.find({ ownerId: ownerId(request) }).sort({ createdAt: -1 }).lean(),
    VoiceAgentModel.find({ ownerId: ownerId(request), "tools.managedBy": "remote_mcp" }).select("name tools").lean(),
  ]);
  response.json({ connections: connections.map((connection) => ({
    ...safeConnection(connection),
    attachedAgents: agents.filter((agent) => agent.tools.some((tool) => tool.managedBy === "remote_mcp" && tool.url.startsWith(`https://mcp.vozon.invalid/${connection._id}/`)))
      .map((agent) => ({ id: String(agent._id), name: agent.name })),
  })) });
}

export async function createRemoteMcpConnection(request: AuthenticatedRequest, response: Response) {
  const body = request.body as Record<string, unknown>;
  const name = String(body.name ?? "").trim().slice(0, 100);
  const provider = String(body.provider ?? "custom").trim().slice(0, 80);
  const token = String(body.token ?? "").trim();
  if (!name || !provider || token.length > 4000) throw new HttpError(400, "Enter a server name and valid credential.");
  const url = await validateRemoteMcpUrl(String(body.url ?? ""));
  let tools: RemoteMcpTool[];
  try { tools = await discoverRemoteMcpTools(url.href, token); }
  catch (error) { throw new HttpError(400, remoteMcpFailureMessage(error)); }
  if (!tools.length) throw new HttpError(400, "This MCP server returned no usable tools for a voice agent.");
  const connection = await RemoteMcpConnectionModel.create({
    ownerId: ownerId(request), name, provider, urlOrigin: url.origin, urlEncrypted: encryptSecret(url.href),
    secretEncrypted: token ? encryptSecret(token) : "",
    tools, status: "connected", lastVerifiedAt: new Date(), lastError: "",
  });
  response.status(201).json({ connection: safeConnection(connection) });
}

export async function verifyRemoteMcpConnection(request: AuthenticatedRequest, response: Response) {
  const connection = await RemoteMcpConnectionModel.findOne({ _id: connectionId(request), ownerId: ownerId(request) }).select("+secretEncrypted +urlEncrypted");
  if (!connection) throw new HttpError(404, "MCP connection not found.");
  try {
    const tools = await discoverRemoteMcpTools(decryptSecret(connection.urlEncrypted), connection.secretEncrypted ? decryptSecret(connection.secretEncrypted) : "");
    if (!tools.length) throw new HttpError(400, "This MCP server returned no usable tools for a voice agent.");
    connection.set({ tools, status: "connected", lastVerifiedAt: new Date(), lastError: "" });
    await connection.save();
  } catch (error) {
    const message = remoteMcpFailureMessage(error);
    connection.set({ status: "error", lastError: message });
    await connection.save();
    throw new HttpError(502, message);
  }
  response.json({ connection: safeConnection(connection) });
}

export async function attachRemoteMcpTools(request: AuthenticatedRequest, response: Response) {
  const body = request.body as Record<string, unknown>;
  const agentId = String(body.agentId ?? "");
  if (!isValidObjectId(agentId)) throw new HttpError(404, "Agent not found.");
  const connection = await RemoteMcpConnectionModel.findOne({ _id: connectionId(request), ownerId: ownerId(request) });
  if (!connection) throw new HttpError(404, "MCP server not found.");
  const agent = await VoiceAgentModel.findOne({ _id: agentId, ownerId: ownerId(request) });
  if (!agent) throw new HttpError(404, "Agent not found.");
  const selected = Array.isArray(body.toolNames) ? body.toolNames.filter((name): name is string => typeof name === "string") : [];
  if (selected.length > 20) throw new HttpError(400, "Select at most 20 MCP tools.");
  if (selected.length && connection.status !== "connected") throw new HttpError(400, "Verify this server before attaching its tools.");
  const available = connection.tools as RemoteMcpTool[];
  const definitions = selected.map((name) => available.find((tool) => tool.name === name));
  if (definitions.some((tool) => !tool)) throw new HttpError(400, "Verify the server again; some selected tools are unavailable.");
  const existing = agent.tools.filter((tool) => !(tool.managedBy === "remote_mcp" && tool.url.startsWith(`https://mcp.vozon.invalid/${connection.id}/`)));
  if (existing.length + selected.length > 20) throw new HttpError(400, "This agent can have at most 20 tools.");
  const names = new Set(existing.map((tool) => tool.name));
  const added = definitions.map((definition) => {
    const tool = definition!;
    const name = attachedMcpToolName(connection.id, tool.name);
    if (names.has(name)) throw new HttpError(400, `Tool name ${name} conflicts with an existing tool.`);
    names.add(name);
    return {
      name, description: tool.description || `Use ${tool.name} on ${connection.name}.`,
      method: "POST" as const, url: `https://mcp.vozon.invalid/${connection.id}/${encodeURIComponent(tool.name)}`,
      headers: {}, timeoutSeconds: 15, enabled: true, parameters: [],
      inputSchema: tool.inputSchema, runAfterCall: false, executeAfterMessage: false,
      excludeSessionId: true, managedBy: "remote_mcp",
    };
  });
  agent.set("tools", [...existing.map((tool) => tool.toObject()), ...added]);
  agent.version += 1;
  await agent.save();
  await invalidateDashboardCache(ownerId(request));
  response.json({ attachedTools: added.map((tool) => tool.name), agentId });
}

export async function deleteRemoteMcpConnection(request: AuthenticatedRequest, response: Response) {
  const id = connectionId(request);
  const owner = ownerId(request);
  const connection = await RemoteMcpConnectionModel.findOne({ _id: id, ownerId: owner });
  if (!connection) throw new HttpError(404, "MCP connection not found.");
  const agents = await VoiceAgentModel.find({ ownerId: owner, "tools.managedBy": "remote_mcp" });
  for (const agent of agents) {
    const kept = agent.tools.filter((tool) => !(tool.managedBy === "remote_mcp" && tool.url.startsWith(`https://mcp.vozon.invalid/${id}/`)));
    if (kept.length !== agent.tools.length) {
      agent.set("tools", kept.map((tool) => tool.toObject()));
      agent.version += 1;
      await agent.save();
    }
  }
  await connection.deleteOne();
  await invalidateDashboardCache(owner);
  response.json({ deleted: true });
}
