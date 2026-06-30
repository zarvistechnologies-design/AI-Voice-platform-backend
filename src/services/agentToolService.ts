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

function unresolvedVariableReference(value: string) {
  return /^\{\{\s*[a-zA-Z][a-zA-Z0-9_/-]{0,140}\s*\}\}$/.test(value)
    || /^\{[a-zA-Z][a-zA-Z0-9_/-]{0,140}\}$/.test(value);
}

function cleanToolValue(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.toLowerCase() === "undefined" || trimmed.toLowerCase() === "null") {
      return undefined;
    }
    if (unresolvedVariableReference(trimmed)) return undefined;
    return value;
  }

  if (Array.isArray(value)) {
    const cleaned = value
      .map((item) => cleanToolValue(item))
      .filter((item) => item !== undefined);
    return cleaned.length ? cleaned : undefined;
  }

  if (typeof value === "object") {
    const cleaned = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, cleanToolValue(item)] as const)
        .filter(([, item]) => item !== undefined),
    );
    return Object.keys(cleaned).length ? cleaned : undefined;
  }

  return value;
}

function cleanToolArgs(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, cleanToolValue(item)] as const)
      .filter(([key, item]) => key && item !== undefined),
  );
}

function setAlias(target: Record<string, unknown>, key: string, value: unknown) {
  if (target[key] !== undefined && target[key] !== "") return;
  const cleaned = cleanToolValue(value);
  if (cleaned !== undefined) target[key] = cleaned;
}

function snakeToCamel(key: string) {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(key)) return "";
  return key.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

function addGenericAliases(args: Record<string, unknown>) {
  const aliased = { ...args };

  for (const [key, value] of Object.entries(args)) {
    const camelKey = snakeToCamel(key);
    if (camelKey) setAlias(aliased, camelKey, value);
  }

  return aliased;
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
    const cleanContext = cleanToolArgs(context);
    const cleanArgs = cleanToolArgs(args);
    const mergedArgs = tool.excludeSessionId === false
      ? { ...cleanContext, ...cleanArgs }
      : cleanArgs;
    const requestArgs = addGenericAliases(mergedArgs);
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
