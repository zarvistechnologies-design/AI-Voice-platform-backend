import { lookup } from "node:dns/promises";
import { lookup as lookupCallback } from "node:dns";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { Agent } from "undici";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { HttpError } from "../utils/httpError.js";

export type RemoteMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export function attachedMcpToolName(id: string, originalName: string) {
  const suffix = createHash("sha256").update(originalName).digest("hex").slice(0, 8);
  return `mcp_${id.slice(-8)}_${originalName.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 50)}_${suffix}`;
}

export function remoteMcpFailureMessage(error: unknown) {
  if (error instanceof HttpError) return error.message;
  const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
  const detail = error instanceof Error ? error.message : "";
  if (status === 401 || status === 403 || /\b(?:401|403)\b/.test(detail)) {
    return "The MCP server rejected authorization. Check the bearer token; OAuth-only servers need a separate sign-in flow.";
  }
  if (status === 404 || /\b404\b/.test(detail)) return "The MCP endpoint returned 404. Check the full server path.";
  if (status === 405 || /\b405\b/.test(detail)) return "The URL does not accept MCP Streamable HTTP requests.";
  return "Could not verify the MCP server. Check its public HTTPS endpoint, transport, and credential.";
}

function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a !== 169 &&
      !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) &&
      !(a === 198 && (b === 18 || b === 19)) &&
      !(a === 192 && b === 0) && !(a === 192 && b === 88) &&
      !(a === 198 && b === 51) && !(a === 203 && b === 0) &&
      a < 224 && !(a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(address) !== 6) return false;
  const value = address.toLowerCase();
  if (value.startsWith("::ffff:")) return publicAddress(value.slice(7));
  return value !== "::" && value !== "::1" && !/^f[cd]/.test(value) &&
    !/^fe[89ab]/.test(value) && !value.startsWith("2001:db8:");
}

export async function validateRemoteMcpUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, "Enter a valid MCP server URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.search ||
    !url.hostname.includes(".") || url.hostname.toLowerCase().endsWith(".local")) {
    throw new HttpError(400, "Use a public HTTPS MCP server URL on port 443 without credentials in the URL.");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
    throw new HttpError(400, "The MCP server must resolve to public addresses.");
  }
  return url;
}

export async function withRemoteMcpClient<T>(
  serverUrl: string,
  token: string,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const url = await validateRemoteMcpUrl(serverUrl);
  const client = new Client({ name: "vozon", version: "1.0.0" });
  const dispatcher = new Agent({ connect: { lookup(hostname, options, callback) {
    lookupCallback(hostname, options, (error, address, family) => {
      if (error) return callback(error, address, family);
      if (Array.isArray(address)) {
        if (address.some((item) => !publicAddress(item.address))) return callback(new Error("MCP server resolved to a private address."), address, family);
      } else if (!publicAddress(address)) {
        return callback(new Error("MCP server resolved to a private address."), address, family);
      }
      callback(null, address, family);
    });
  } } });
  const transport = new StreamableHTTPClientTransport(url, {
    ...(token ? { authProvider: { token: async () => token } } : {}),
    requestInit: { redirect: "error" },
    fetch: async (input, init) => {
      const requestUrl = new URL(input instanceof Request ? input.url : String(input));
      if (requestUrl.origin !== url.origin) throw new HttpError(400, "MCP server redirected to another origin.");
      await validateRemoteMcpUrl(requestUrl.href);
      return fetch(input, { ...init, redirect: "error", dispatcher,
        signal: AbortSignal.any([init?.signal ?? new AbortController().signal, AbortSignal.timeout(15_000)]) } as RequestInit);
    },
  });
  try {
    await client.connect(transport);
    return await operation(client);
  } finally {
    await client.close().catch(() => undefined);
    await dispatcher.close();
  }
}

export async function discoverRemoteMcpTools(serverUrl: string, token: string): Promise<RemoteMcpTool[]> {
  return withRemoteMcpClient(serverUrl, token, async (client) => {
    const tools: RemoteMcpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools) {
        if (/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name) &&
          tool.inputSchema?.type === "object" && JSON.stringify(tool.inputSchema).length <= 12_000) {
          tools.push({ name: tool.name, description: String(tool.description ?? "").slice(0, 500), inputSchema: tool.inputSchema as Record<string, unknown> });
        }
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < 100);
    return tools.slice(0, 100);
  });
}

export async function callRemoteMcpTool(serverUrl: string, token: string, name: string, args: Record<string, unknown>) {
  return withRemoteMcpClient(serverUrl, token, (client) => client.callTool({ name, arguments: args }));
}
