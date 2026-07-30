type AgentRuntimeError = {
  type?: string;
  recoverable?: boolean;
};

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
