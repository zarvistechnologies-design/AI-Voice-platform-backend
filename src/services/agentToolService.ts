export type AgentWebhookTool = {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  timeoutSeconds: number;
  excludeSessionId?: boolean;
};

export type AgentToolRunResult = {
  ok: boolean;
  status: number;
  elapsedMs: number;
  responseText: string;
};

export function objectArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizedHeaders(value: AgentWebhookTool["headers"]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, headerValue]) => [key.trim(), String(headerValue ?? "").trim()] as const)
      .filter(([key, headerValue]) => key && headerValue),
  );
}

export async function executeWebhookTool(
  tool: AgentWebhookTool,
  args: Record<string, unknown>,
  context: Record<string, unknown> = {},
): Promise<AgentToolRunResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), tool.timeoutSeconds * 1000);
  const startedAt = Date.now();

  try {
    const url = new URL(tool.url);
    const requestArgs = tool.excludeSessionId === false
      ? { ...context, ...args }
      : args;
    const init: RequestInit = {
      method: tool.method,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...normalizedHeaders(tool.headers) },
    };

    if (tool.method === "GET") {
      for (const [key, value] of Object.entries(requestArgs)) {
        url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    } else {
      init.body = JSON.stringify(requestArgs);
    }

    const response = await fetch(url, init);
    const responseText = (await response.text()).slice(0, 10000);
    return {
      ok: response.ok,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      responseText,
    };
  } finally {
    clearTimeout(timeout);
  }
}
