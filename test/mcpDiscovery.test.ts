import assert from "node:assert/strict";
import test from "node:test";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/server";

test("MCP discovery uses one public URL behind Render and the frontend proxy", async () => {
  process.env.NODE_ENV = "production";
  process.env.RENDER = "true";
  process.env.MCP_SERVER_URL = "https://vozon.onrender.com/mcp";

  const { getMcpAuthorizationMetadata, getMcpProtectedResourceMetadata, getMcpServerUrl } =
    await import("../src/controllers/mcpOAuthController.js");

  const serverUrl = getMcpServerUrl();
  assert.equal(serverUrl.href, "https://api.vozon.ai/mcp");
  assert.equal(
    getOAuthProtectedResourceMetadataUrl(serverUrl),
    "https://api.vozon.ai/.well-known/oauth-protected-resource/mcp",
  );
  assert.deepEqual(getMcpProtectedResourceMetadata(), {
    resource: serverUrl.href,
    authorization_servers: ["https://api.vozon.ai"],
    bearer_methods_supported: ["header"],
    scopes_supported: ["vozon:read"],
    resource_name: "Vozon",
  });
  const auth = getMcpAuthorizationMetadata();
  assert.equal(auth.issuer, "https://api.vozon.ai");
  assert.equal(auth.registration_endpoint, "https://api.vozon.ai/oauth/register");
});
