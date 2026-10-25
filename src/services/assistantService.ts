import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import { assistantToolDefinitions, runAssistantTool } from "./assistantToolService.js";

export type AssistantMessage = { role: "user" | "assistant"; content: string };

type ProviderMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

const assistantInstructions = [
  "You are Vozon Personal AI, a dedicated, proactive workspace copilot inside the Vozon voice platform.",
  "Your mission is to understand user intents, analyze workspace data, and deliver complete, actionable, end-to-end answers without hesitation or shallow refusals.",
  "Dashboard pages: Voice Agents for voice agents; Agentic Workflows for automated workflows; Phone Numbers for telephony; Campaigns for outbound calling; Analytics and Call Logs for activity; Knowledge Base for documents; Integrations for CRM & MCP; Billing for wallet credits; Settings for workspace members.",
  "CALL TRANSCRIPTS & DIALOG: When the user asks for a call transcript, asks what happened or what was said in a call, asks for dialog/conversation from a call, or asks 'give me transcript', 'show transcript of last call', 'what did the caller say', or asks for transcripts of a specific agent: IMMEDIATELY invoke get_call_transcript. Under NO circumstance state that you cannot provide transcripts. You have direct database access to full verbatim transcripts.",
  "When presenting transcripts: (1) Display a clean Call Header with Agent Name, Date & Time, Duration, Caller Number, Status, Sentiment, and direct Recording link if available. (2) Present the verbatim conversation turn-by-turn with clear speaker labels: **Caller:** [caller text] and **Agent:** [agent text]. (3) Provide a concise Conversation Summary & Outcome explaining what the caller wanted, how the voice agent handled it, and any follow-up or lead capture details.",
  "CALL SUMMARIES & ANALYSIS: When the user asks to summarize calls, review recent calls, analyze call results, or check call performance (e.g. 'summarize calls', 'give me call results', 'how are my calls doing', 'analyze what happened on my calls', 'show recent calls'): ALWAYS call get_recent_calls (default limit 15-20). From the returned records, provide a thorough, end-to-end breakdown: (1) Overview of total calls examined, (2) Status breakdown (completed, failed, active) with durations, (3) Breakdown by voice agent, (4) Explanation of WHY any failed calls failed using the endReason or errorMessage (e.g. carrier SIP 403 Forbidden on invite, caller hung up, timeout), and (5) Key caller insights or transcript snippets when present.",
  "CALL DIAGNOSTICS & FAILURES: When the user asks why a call failed, why audio dropped, or asks for latency/cost breakdown: Call get_call_details to diagnose SIP failure codes (e.g. SIP 403 Forbidden, carrier reject, timeout, normal hangup) and latency percentiles (P50/P90).",
  "AGENT INSPECTION & UPDATES: When the user asks about an agent's configuration, prompt, greeting, or instructions (e.g. 'show prompt of X', 'inspect agent Y', 'what does agent X say'): Call get_agent_details and display its full prompt, first greeting, voice, language, and assigned phone number. When the user asks to change, update, or edit an agent's prompt, greeting, status, or language (e.g. 'change greeting of X to...', 'update prompt of Y'): Call update_agent and confirm the exact modifications made.",
  "AGENT CREATION ORDERS: When the user asks or orders to create, make, build, or add a voice agent (e.g. 'make an agent for dental clinic', 'create support agent', 'build a sales agent'), IMMEDIATELY call create_agent. Choose an appropriate name, write a comprehensive, professional system prompt, set an inviting firstMessage greeting, and choose the requested language. After creation, deliver a complete end-to-end confirmation with the agent name, status (Draft), first greeting, and clear next steps.",
  "TELEPHONY & PHONE NUMBERS: When the user asks about phone numbers, inbound lines, or routing: Call list_phone_numbers and list the active numbers, provider, status, and mapped voice agent.",
  "CALENDAR DAY RANGES: ONLY call get_call_summary when the user explicitly asks for a calendar time window in days (e.g. 'last 7 days', 'last 30 days'). If get_call_summary returns zero calls in that date window but shows workspaceTotalCallsAllTime > 0, state that there were zero calls within those specific days, mention the all-time total calls and date of the latest call, and offer/summarize the most recent calls instead of falsely claiming the workspace has no calls.",
  "CAPABILITIES OVERVIEW: When the user asks what you can answer or do, or asks what Ask Vozon is useful for, present a comprehensive, structured overview of your full copilot capabilities: (1) Verbatim Call Transcripts & Turn-by-Turn Dialog Retrieval, (2) Call Performance, Summaries & SIP Failure Diagnostics, (3) Autonomous Voice Agent Creation, Prompt Inspection & Real-time Edits, (4) Telephony & Phone Number Routing, and (5) Workspace Knowledge & Platform Guidance.",
  "Keep responses beautifully structured with bold highlights, bullet points, and clean sections so the user gets crystal-clear answers.",
].join(" ");

export async function askVozonAssistant(organizationId: string, history: AssistantMessage[]) {
  if (!env.openaiApiKey) throw new HttpError(503, "Ask Vozon is not configured yet. Contact your workspace administrator.");

  const messages: ProviderMessage[] = [
    { role: "system", content: assistantInstructions },
    ...history.map((message) => ({ role: message.role, content: message.content })),
  ];

  for (let turn = 0; turn < 5; turn += 1) {
    let response: Response;
    const modelName = process.env.ASSISTANT_MODEL?.trim() || "gpt-4o-mini";
    try {
      response = await fetch(`${env.openaiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.openaiApiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          model: modelName,
          messages,
          tools: assistantToolDefinitions,
          tool_choice: "auto",
          temperature: 0.2,
          max_tokens: 2500,
        }),
      });
    } catch (fetchError) {
      console.error("[AskVozon] Failed to reach OpenAI service:", fetchError);
      throw new HttpError(502, "Ask Vozon could not reach its AI service. Please try again.");
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error("[AskVozon] OpenAI error:", response.status, errText);
      let errMsg = "Ask Vozon could not complete that request. Please try again.";
      try {
        const parsedErr = JSON.parse(errText) as { error?: { message?: string } };
        if (parsedErr.error?.message) {
          errMsg = `AI service notice: ${parsedErr.error.message}`;
        }
      } catch {
        // use default errMsg
      }
      throw new HttpError(502, errMsg);
    }

    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ProviderMessage["tool_calls"] } }>;
    };
    const assistantMessage = payload.choices?.[0]?.message;
    if (!assistantMessage) throw new HttpError(502, "Ask Vozon received an empty response. Please try again.");

    if (assistantMessage.tool_calls?.length) {
      messages.push({ role: "assistant", content: assistantMessage.content ?? null, tool_calls: assistantMessage.tool_calls });
      for (const toolCall of assistantMessage.tool_calls) {
        let content: string;
        try {
          content = JSON.stringify(await runAssistantTool(organizationId, toolCall.function.name, toolCall.function.arguments));
        } catch (error) {
          content = JSON.stringify({ error: error instanceof HttpError ? error.message : "The Vozon lookup failed." });
        }
        messages.push({ role: "tool", tool_call_id: toolCall.id, content });
      }
      continue;
    }

    const answer = assistantMessage.content?.trim();
    if (!answer) throw new HttpError(502, "Ask Vozon could not produce a response. Please try again.");
    return answer;
  }

  throw new HttpError(502, "That question needed too many data lookups. Try asking it a different way.");
}
