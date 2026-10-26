import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client";
import { app } from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";
import { OrganizationModel } from "../src/models/Organization.js";
import { OrganizationMemberModel } from "../src/models/OrganizationMember.js";
import { RemoteMcpConnectionModel } from "../src/models/RemoteMcpConnection.js";
import { UserModel } from "../src/models/User.js";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";
import { decryptSecret } from "../src/utils/secretCrypto.js";
import { ensureDefaultOrganization } from "../src/services/organizationService.js";

const originalFetch = globalThis.fetch;
const methods: string[] = [];
globalThis.fetch = async (input, init) => {
  const url = input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);
  if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
  if (url !== "https://1.1.1.1/mcp") throw new Error(`Unexpected URL: ${url}`);
  const body = init?.body ? JSON.parse(String(init.body)) as { id?: number; method?: string; params?: Record<string, unknown> } : null;
  if (!body?.method) return new Response(null, { status: 405 });
  methods.push(body.method);
  if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
  const result = body.method === "initialize"
    ? { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0.0" } }
    : body.method === "tools/list"
      ? { tools: [{ name: "echo", description: "Echo a message", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }] }
      : body.method === "tools/call"
        ? { content: [{ type: "text", text: JSON.stringify(body.params) }] }
        : {};
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
};

let ownerId = "";
let userId = "";
let cookie = "";
let server: ReturnType<typeof app.listen> | undefined;
try {
  await connectDatabase();
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await originalFetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json().catch(() => null) as Record<string, unknown> | null,
      cookie: response.headers.get("set-cookie") ?? "" };
  }
  const email = `mcp-smoke-${Date.now()}@example.com`;
  const password = "mcp-smoke-test-password";
  const user = await UserModel.create({ name: "MCP Smoke", email, passwordHash: await bcrypt.hash(password, 12), emailVerified: true, welcomeEmailSentAt: new Date() });
  userId = user.id;
  const { organization } = await ensureDefaultOrganization(user);
  ownerId = organization.id;
  const login = await api("/api/auth/login", "POST", { email, password });
  if (login.status !== 200) throw new Error(`Login failed: ${JSON.stringify(login.data)}`);
  cookie = login.cookie.split(";")[0] ?? "";
  const agents = await api("/api/voice/agents");
  const agentId = String(((agents.data?.agents as Array<{ _id: string }> | undefined) ?? [])[0]?._id ?? "");
  if (!agentId) throw new Error("Starter agent missing.");
  const created = await api("/api/integrations/mcp-servers", "POST", {
    name: "Mock MCP", provider: "Notion", url: "https://1.1.1.1/mcp", token: "secret-test-token",
  });
  if (created.status !== 201) throw new Error(`MCP connection failed: ${JSON.stringify(created.data)}`);
  const connectionId = String((created.data?.connection as { id?: string } | undefined)?.id ?? "");
  const saved = await RemoteMcpConnectionModel.findById(connectionId).select("+secretEncrypted +urlEncrypted");
  if (!saved || saved.secretEncrypted.includes("secret-test-token") || decryptSecret(saved.secretEncrypted) !== "secret-test-token"
    || saved.urlEncrypted.includes("https://1.1.1.1/mcp") || decryptSecret(saved.urlEncrypted) !== "https://1.1.1.1/mcp") {
    throw new Error("MCP credential or endpoint was not encrypted correctly.");
  }
  const listed = await api("/api/integrations/mcp-servers");
  if (listed.status !== 200 || JSON.stringify(listed.data).includes("secret-test-token")) throw new Error("MCP list leaked a credential.");
  const attached = await api(`/api/integrations/mcp-servers/${connectionId}/attach`, "POST", { agentId, toolNames: ["echo"] });
  if (attached.status !== 200) throw new Error(`MCP attach failed: ${JSON.stringify(attached.data)}`);
  const agent = await VoiceAgentModel.findById(agentId);
  const tool = agent?.tools.find((item) => item.managedBy === "remote_mcp");
  if (!tool || !tool.inputSchema) throw new Error("Attached agent tool lost its MCP schema.");
  const originalUrl = tool.url;
  const editorSave = await api(`/api/voice/agents/${agentId}`, "PUT", {
    version: agent?.version,
    tools: [{ _id: String(tool._id), name: tool.name, description: "Tampered", method: "POST",
      url: "https://attacker.example/tool", managedBy: "remote_mcp" }],
  });
  if (editorSave.status !== 200 || (await VoiceAgentModel.findById(agentId))?.tools.find((item) => item.name === tool.name)?.url !== originalUrl) {
    throw new Error("Agent editor changed a managed MCP tool.");
  }
  const called = await api(`/api/voice/agents/${agentId}/tools/test`, "POST", { toolId: tool.name, args: { message: "hello" } });
  if (called.status !== 200 || !JSON.stringify(called.data).includes("hello") || !methods.includes("tools/call")) {
    throw new Error(`MCP tool call failed: ${JSON.stringify(called.data)}`);
  }
  const detached = await api(`/api/integrations/mcp-servers/${connectionId}/attach`, "POST", { agentId, toolNames: [] });
  if (detached.status !== 200 || (await VoiceAgentModel.findById(agentId))?.tools.some((item) => item.managedBy === "remote_mcp")) {
    throw new Error("MCP detach failed.");
  }
  const removed = await api(`/api/integrations/mcp-servers/${connectionId}`, "DELETE");
  if (removed.status !== 200 || await RemoteMcpConnectionModel.exists({ _id: connectionId })) throw new Error("MCP removal failed.");
  console.log(JSON.stringify({ passed: true, checks: ["connect", "encrypted credential and URL", "redacted list", "tool discovery", "agent attach", "managed tool protection", "agent tool call", "agent detach", "disconnect"] }));
} finally {
  globalThis.fetch = originalFetch;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (ownerId) {
    await Promise.all([
      RemoteMcpConnectionModel.deleteMany({ ownerId }), VoiceAgentModel.deleteMany({ ownerId }),
      OrganizationMemberModel.deleteMany({ orgId: ownerId }), OrganizationModel.deleteOne({ _id: ownerId }),
    ]);
  }
  if (userId) await UserModel.deleteOne({ _id: userId });
  await mongoose.disconnect();
}
process.exit(0);
