import assert from "node:assert/strict";
import test from "node:test";

import { previewTokenProvider, verifyTokenProvider } from "../src/services/tokenProviderService.js";

async function withFetch(
  responder: (url: string, init?: RequestInit) => Response,
  run: () => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => responder(String(input), init);
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("Asana verifies a token and previews projects in an accessible workspace", async () => {
  await withFetch((url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer token");
    if (url.endsWith("/users/me")) return json({ data: { gid: "user-1", name: "Asana User" } });
    if (url.includes("/workspaces?")) return json({ data: [{ gid: "workspace-1" }] });
    if (url.includes("/projects?")) return json({ data: [{ gid: "project-1", name: "Follow ups" }] });
    throw new Error(`Unexpected Asana URL ${url}`);
  }, async () => {
    assert.deepEqual(await verifyTokenProvider("asana", "token"), { accountId: "Asana User" });
    assert.deepEqual(await previewTokenProvider("asana", "token"), { items: [{ id: "project-1", name: "Follow ups", type: "project" }] });
  });
});

test("ClickUp verifies a token and previews authorized workspaces", async () => {
  await withFetch((url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "pk_example");
    if (url.endsWith("/user")) return json({ user: { id: 1, username: "ClickUp User" } });
    if (url.endsWith("/team")) return json({ teams: [{ id: 2, name: "Sales" }] });
    throw new Error(`Unexpected ClickUp URL ${url}`);
  }, async () => {
    assert.deepEqual(await verifyTokenProvider("clickup", "pk_example"), { accountId: "ClickUp User" });
    assert.deepEqual(await previewTokenProvider("clickup", "pk_example"), { items: [{ id: "2", name: "Sales", type: "workspace" }] });
  });
});

test("Linear verifies GraphQL data, previews issues, and rejects GraphQL errors", async () => {
  let graphqlError = false;
  await withFetch((url, init) => {
    assert.equal(url, "https://api.linear.app/graphql");
    assert.equal(new Headers(init?.headers).get("Authorization"), "lin_api_example");
    if (graphqlError) return json({ errors: [{ message: "Denied" }] });
    const query = JSON.parse(String(init?.body)).query as string;
    return query.includes("viewer")
      ? json({ data: { viewer: { id: "user-1", name: "Linear User" } } })
      : json({ data: { issues: { nodes: [{ id: "issue-1", title: "Call back" }] } } });
  }, async () => {
    assert.deepEqual(await verifyTokenProvider("linear", "lin_api_example"), { accountId: "Linear User" });
    assert.deepEqual(await previewTokenProvider("linear", "lin_api_example"), { items: [{ id: "issue-1", name: "Call back", type: "issue" }] });
    graphqlError = true;
    await assert.rejects(verifyTokenProvider("linear", "lin_api_example"), /rejected/i);
  });
});

test("monday.com verifies the user and previews boards", async () => {
  await withFetch((url, init) => {
    assert.equal(url, "https://api.monday.com/v2");
    assert.equal(new Headers(init?.headers).get("Authorization"), "monday_token");
    const query = JSON.parse(String(init?.body)).query as string;
    return query.includes("me {")
      ? json({ data: { me: { id: "1", name: "Monday User" } } })
      : json({ data: { boards: [{ id: "board-1", name: "Leads" }] } });
  }, async () => {
    assert.deepEqual(await verifyTokenProvider("monday", "monday_token"), { accountId: "Monday User" });
    assert.deepEqual(await previewTokenProvider("monday", "monday_token"), { items: [{ id: "board-1", name: "Leads", type: "board" }] });
  });
});

test("Notion verifies the bot and previews shared pages", async () => {
  await withFetch((url, init) => {
    assert.equal(new Headers(init?.headers).get("Notion-Version"), "2022-06-28");
    if (url.endsWith("/users/me")) return json({ id: "bot-1", name: "Vozon Bot" });
    if (url.endsWith("/search")) return json({ results: [{ id: "page-1", object: "page", properties: { title: { title: [{ plain_text: "Call playbook" }] } } }] });
    throw new Error(`Unexpected Notion URL ${url}`);
  }, async () => {
    assert.deepEqual(await verifyTokenProvider("notion", "notion_token"), { accountId: "Vozon Bot" });
    assert.deepEqual(await previewTokenProvider("notion", "notion_token"), { items: [{ id: "page-1", name: "Call playbook", type: "page" }] });
  });
});
