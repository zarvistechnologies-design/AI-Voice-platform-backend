import { digitalBotAppointmentWebhookKind } from "./digitalBotToolPolicy.js";

export type AgentWebhookTool = {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  timeoutSeconds: number;
  excludeSessionId?: boolean;
  managedBy?: string;
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

function webhookRequestHeaders(value: AgentWebhookTool["headers"]) {
  const headers = new Headers(normalizedHeaders(value));
  headers.set("Content-Type", "application/json");
  return headers;
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

function isDigitalBotAvailabilityTool(tool: AgentWebhookTool) {
  return digitalBotAppointmentWebhookKind(tool) === "availability";
}

function toolResponseLimit(tool: AgentWebhookTool) {
  return isDigitalBotAvailabilityTool(tool) ? 250_000 : 10_000;
}

function transientAvailabilityFailure(status: number, responseText: string) {
  if (status === 408 || status === 429 || status >= 500) return true;
  try {
    const data = JSON.parse(responseText) as Record<string, unknown>;
    const message = [data.error, data.message, data.reason]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    return data.success === false
      && /fetch failed|temporar|timeout|timed out|unavailable|connection|socket|network/i.test(message);
  } catch {
    return false;
  }
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
    const mergedArgs = tool.excludeSessionId === false || digitalBotAppointmentWebhookKind(tool) !== null
      ? { ...cleanContext, ...cleanArgs }
      : cleanArgs;
    const requestArgs = addGenericAliases(mergedArgs);
    if (tool.method === "GET") {
      for (const [key, value] of Object.entries(requestArgs)) {
        url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    }

    const attempts = isDigitalBotAvailabilityTool(tool) ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const init: RequestInit = {
        method: tool.method,
        signal: controller.signal,
        headers: webhookRequestHeaders(tool.headers),
        ...(tool.method === "GET" ? {} : { body: JSON.stringify(requestArgs) }),
      };
      const response = await fetch(url, init);
      const responseText = (await response.text()).slice(0, toolResponseLimit(tool));
      if (attempt < attempts && transientAvailabilityFailure(response.status, responseText)) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      return {
        ok: response.ok,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        responseText,
      };
    }
    throw new Error(`${tool.name} did not return a response.`);
  } finally {
    clearTimeout(timeout);
  }
}
