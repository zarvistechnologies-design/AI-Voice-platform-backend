export type AgentWebhookTool = {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  timeoutSeconds: number;
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

export async function executeWebhookTool(
  tool: AgentWebhookTool,
  args: Record<string, unknown>,
): Promise<AgentToolRunResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), tool.timeoutSeconds * 1000);
  const startedAt = Date.now();

  try {
    const url = new URL(tool.url);
    const init: RequestInit = {
      method: tool.method,
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
    };

    if (tool.method === "GET") {
      for (const [key, value] of Object.entries(args)) {
        url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    } else {
      init.body = JSON.stringify(args);
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
