type AgentRuntimeError = {
  type?: string;
  recoverable?: boolean;
};

const diagnosticFields = [
  "code",
  "status",
  "statusCode",
  "type",
  "requestId",
  "retryable",
  "body",
] as const;

const sensitiveDiagnosticKey = /authorization|api[-_]?key|token|secret|password|cookie/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jsonSafeDiagnosticValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (value === undefined) return undefined;
  if (depth >= 4) return "[truncated]";
  if (value instanceof Error) return serializeProviderError(value, depth + 1, seen);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => jsonSafeDiagnosticValue(item, depth + 1, seen));
  }
  if (!isRecord(value)) return String(value);
  if (seen.has(value)) return "[circular]";

  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    output[key] = sensitiveDiagnosticKey.test(key)
      ? "[redacted]"
      : jsonSafeDiagnosticValue(item, depth + 1, seen);
  }
  return output;
}

function serializeProviderError(
  error: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): Record<string, unknown> {
  if (!isRecord(error)) {
    return {
      name: "NonError",
      message: error === undefined ? "Unknown provider error" : String(error),
    };
  }

  const output: Record<string, unknown> = {
    name: typeof error.name === "string" ? error.name : error.constructor?.name ?? "Error",
    message: typeof error.message === "string" ? error.message : "Unknown provider error",
  };
  if (typeof error.stack === "string") output.stack = error.stack;
  for (const field of diagnosticFields) {
    const value = error[field];
    if (value !== undefined) output[field] = jsonSafeDiagnosticValue(value, depth + 1, seen);
  }
  if (error.cause !== undefined) {
    output.cause = jsonSafeDiagnosticValue(error.cause, depth + 1, seen);
  }
  return output;
}

/**
 * Converts LiveKit/provider error events into JSON-safe diagnostics. Native
 * Error properties are non-enumerable, so passing the event directly to
 * JSON.stringify otherwise turns its nested error into an empty object.
 */
export function serializeAgentError(error: unknown): Record<string, unknown> {
  if (!isRecord(error) || error instanceof Error) return serializeProviderError(error);

  const output: Record<string, unknown> = {};
  for (const field of ["type", "timestamp", "label", "recoverable"] as const) {
    const value = error[field];
    if (value !== undefined) output[field] = value;
  }
  output.error = serializeProviderError(error.error);
  return output;
}

export type AgentErrorDisposition = "retrying" | "session_managed";

/**
 * AgentSession error events are diagnostic, not terminal. Recoverable errors
 * are emitted between provider retry attempts, while unrecoverable LLM/TTS
 * errors are tolerated up to the SDK's configured threshold. The Close event
 * is the single authority for deciding whether the call actually failed.
 */
export function agentErrorDisposition(error: AgentRuntimeError): AgentErrorDisposition {
  return error.recoverable ? "retrying" : "session_managed";
}

export function shouldFailCallFromSessionClose(error: unknown) {
  return error !== null && error !== undefined;
}
