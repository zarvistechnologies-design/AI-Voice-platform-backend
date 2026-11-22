import { HttpError } from "../utils/httpError.js";

export const tokenProviders = ["asana", "clickup", "linear", "monday", "notion"] as const;
export type TokenProvider = (typeof tokenProviders)[number];

export function isTokenProvider(value: string): value is TokenProvider {
  return tokenProviders.includes(value as TokenProvider);
}

type ProviderResource = { id: string; name: string; type: string };

async function providerJson(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const data = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new HttpError(400, "The provider rejected this token or its permissions.");
      if (response.status === 429) throw new HttpError(429, "The provider rate limit was reached. Try again later.");
      throw new HttpError(502, `The provider returned HTTP ${response.status}.`);
    }
    if (!data || typeof data !== "object") throw new HttpError(502, "The provider returned an invalid response.");
    if (Array.isArray(data.errors) && data.errors.length) throw new HttpError(400, "The provider rejected this token or query.");
    return data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Could not reach the provider. Try again later.");
  } finally {
    clearTimeout(timeout);
  }
}

function notionHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
}

export async function verifyTokenProvider(provider: TokenProvider, token: string) {
  const secret = token.trim();
  if (!secret || secret.length > 2048) throw new HttpError(400, "Enter a valid provider token.");
  if (provider === "asana") {
    const result = await providerJson("https://app.asana.com/api/1.0/users/me", { headers: { Authorization: `Bearer ${secret}` } });
    const user = result.data as Record<string, unknown> | undefined;
    if (!user?.gid) throw new HttpError(502, "Asana returned an invalid account response.");
    return { accountId: String(user.name || "Asana account") };
  }
  if (provider === "clickup") {
    const result = await providerJson("https://api.clickup.com/api/v2/user", { headers: { Authorization: secret } });
    const user = result.user as Record<string, unknown> | undefined;
    if (!user?.id) throw new HttpError(502, "ClickUp returned an invalid account response.");
    return { accountId: String(user.username || user.email || "ClickUp account") };
  }
  if (provider === "linear") {
    const result = await providerJson("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: secret, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { viewer { id name } }" }),
    });
    const viewer = (result.data as Record<string, unknown> | undefined)?.viewer as Record<string, unknown> | undefined;
    if (!viewer?.id) throw new HttpError(502, "Linear returned an invalid account response.");
    return { accountId: String(viewer.name || "Linear account") };
  }
  if (provider === "monday") {
    const result = await providerJson("https://api.monday.com/v2", {
      method: "POST",
      headers: { Authorization: secret, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { me { id name } }" }),
    });
    const me = (result.data as Record<string, unknown> | undefined)?.me as Record<string, unknown> | undefined;
    if (!me?.id) throw new HttpError(502, "monday.com returned an invalid account response.");
    return { accountId: String(me.name || "monday.com account") };
  }
  const result = await providerJson("https://api.notion.com/v1/users/me", { headers: notionHeaders(secret) });
  if (!result.id) throw new HttpError(502, "Notion returned an invalid account response.");
  return { accountId: String(result.name || "Notion workspace") };
}

export async function previewTokenProvider(provider: TokenProvider, token: string): Promise<{ items: ProviderResource[] }> {
  const secret = token.trim();
  if (provider === "asana") {
    const workspaces = await providerJson("https://app.asana.com/api/1.0/workspaces?limit=1", { headers: { Authorization: `Bearer ${secret}` } });
    const workspace = Array.isArray(workspaces.data) ? workspaces.data[0] as Record<string, unknown> | undefined : undefined;
    if (!workspace?.gid) return { items: [] };
    const result = await providerJson(`https://app.asana.com/api/1.0/workspaces/${encodeURIComponent(String(workspace.gid))}/projects?limit=5`, { headers: { Authorization: `Bearer ${secret}` } });
    return { items: Array.isArray(result.data) ? result.data.map((entry: Record<string, unknown>) => ({ id: String(entry.gid ?? ""), name: String(entry.name ?? "Project"), type: "project" })) : [] };
  }
  if (provider === "clickup") {
    const result = await providerJson("https://api.clickup.com/api/v2/team", { headers: { Authorization: secret } });
    return { items: Array.isArray(result.teams) ? result.teams.slice(0, 5).map((entry: Record<string, unknown>) => ({ id: String(entry.id ?? ""), name: String(entry.name ?? "Workspace"), type: "workspace" })) : [] };
  }
  if (provider === "linear") {
    const result = await providerJson("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: secret, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { issues(first: 5) { nodes { id title } } }" }),
    });
    const issues = (result.data as Record<string, unknown> | undefined)?.issues as Record<string, unknown> | undefined;
    return { items: Array.isArray(issues?.nodes) ? issues.nodes.map((entry: Record<string, unknown>) => ({ id: String(entry.id ?? ""), name: String(entry.title ?? "Issue"), type: "issue" })) : [] };
  }
  if (provider === "monday") {
    const result = await providerJson("https://api.monday.com/v2", {
      method: "POST",
      headers: { Authorization: secret, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { boards(limit: 5) { id name } }" }),
    });
    const boards = (result.data as Record<string, unknown> | undefined)?.boards;
    return { items: Array.isArray(boards) ? boards.map((entry: Record<string, unknown>) => ({ id: String(entry.id ?? ""), name: String(entry.name ?? "Board"), type: "board" })) : [] };
  }
  const result = await providerJson("https://api.notion.com/v1/search", {
    method: "POST",
    headers: notionHeaders(secret),
    body: JSON.stringify({ page_size: 5 }),
  });
  return {
    items: Array.isArray(result.results) ? result.results.map((entry: Record<string, unknown>) => {
      const properties = entry.properties as Record<string, unknown> | undefined;
      const title = (properties?.title as Record<string, unknown> | undefined)?.title as Array<Record<string, unknown>> | undefined;
      return { id: String(entry.id ?? ""), name: String(title?.[0]?.plain_text ?? "Notion page"), type: String(entry.object ?? "page") };
    }) : [],
  };
}
