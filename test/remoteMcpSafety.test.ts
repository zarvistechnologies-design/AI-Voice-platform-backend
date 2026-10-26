import assert from "node:assert/strict";
import { test } from "node:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client";
import { VoiceAgentModel } from "../src/models/VoiceAgent.js";
import { attachedMcpToolName, callRemoteMcpTool, discoverRemoteMcpTools, remoteMcpFailureMessage, validateRemoteMcpUrl } from "../src/services/remoteMcpService.js";

test("remote MCP URLs reject private networks and unsafe schemes", async () => {
  for (const url of [
    "http://example.com/mcp", "https://127.0.0.1/mcp", "https://10.0.0.1/mcp",
    "https://169.254.169.254/latest/meta-data", "https://localhost/mcp",
    "https://user:password@example.com/mcp", "https://example.com:8443/mcp",
    "https://example.com/mcp?token=secret",
  ]) {
    await assert.rejects(validateRemoteMcpUrl(url), { statusCode: 400 }, url);
  }
});

test("MCP failures explain 404 and never echo a credential", () => {
  assert.match(remoteMcpFailureMessage(new Error("HTTP 404 for https://example.com/mcp?token=secret")), /404/);
  assert.doesNotMatch(remoteMcpFailureMessage(new Error("Authorization failed for secret-test-token")), /secret-test-token/);
});

test("attached MCP tools keep their schema and a safe generated name", () => {
  const name = attachedMcpToolName("507f1f77bcf86cd799439011", "search-records");
  assert.match(name, /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/);
  const agent = new VoiceAgentModel({
    ownerId: "test-owner", name: "Test", team: "Test", prompt: "Test", firstMessage: "Hello",
    tools: [{ name, description: "Search", method: "POST", url: "https://mcp.vozon.invalid/507f1f77bcf86cd799439011/search-records",
      managedBy: "remote_mcp", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
  });
  assert.equal(agent.tools[0]?.managedBy, "remote_mcp");
  assert.deepEqual(agent.tools[0]?.inputSchema, { type: "object", properties: { query: { type: "string" } }, required: ["query"] });
});

test("remote MCP handshake, tool discovery, and tool call", async () => {
  const previousFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { id?: number; method?: string; params?: Record<string, unknown> } : null;
    if (!body?.method) return new Response(null, { status: 405 });
    methods.push(body.method);
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = body.method === "initialize"
      ? { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0.0" } }
      : body.method === "tools/list"
        ? { tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { message: { type: "string" } } } }] }
        : body.method === "tools/call"
          ? { content: [{ type: "text", text: JSON.stringify(body.params) }] }
          : {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  };
  try {
    const tools = await discoverRemoteMcpTools("https://1.1.1.1/mcp", "test-token");
    assert.deepEqual(tools.map((tool) => tool.name), ["echo"]);
    const result = await callRemoteMcpTool("https://1.1.1.1/mcp", "test-token", "echo", { message: "hello" });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result), /hello/);
    assert.ok(methods.includes("initialize"));
    assert.ok(methods.includes("tools/list"));
    assert.ok(methods.includes("tools/call"));
  } finally {
    globalThis.fetch = previousFetch;
  }
});
