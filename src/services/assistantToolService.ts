import { Types } from "mongoose";

import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { OrganizationModel } from "../models/Organization.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { WhiteLabelSubscriptionModel } from "../models/WhiteLabelSubscription.js";
import {
  getAssistantAgentPerformance,
  getAssistantCampaignPerformance,
  getAssistantFollowUpCandidates,
  listAssistantCampaigns,
  searchAssistantKnowledge,
} from "./assistantInsightsService.js";
import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

export const assistantToolDefinitions = [
  {
    type: "function",
    function: {
      name: "list_agents",
      description: "List the voice agents in the signed-in Vozon workspace with their status, language, voice, and assigned phone.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_agent_details",
      description: "Inspect the complete configuration of a specific voice agent, including its system prompt, greeting (firstMessage), voice, language, status, and assigned phone number.",
      parameters: {
        type: "object",
        properties: {
          agentNameOrId: {
            type: "string",
            description: "The name or ID of the voice agent to inspect.",
          },
        },
        required: ["agentNameOrId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_agent",
      description: "Create a new voice agent in this workspace. Call this whenever the user asks to create, make, build, or add a voice agent.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the agent (e.g. 'Customer Support', 'Booking Assistant')." },
          prompt: { type: "string", description: "System instructions or behavioral prompt for the voice agent." },
          firstMessage: { type: "string", description: "First greeting the agent speaks when answering a call." },
          language: { type: "string", description: "Language for the voice agent (e.g. 'English', 'Hindi'). Defaults to 'English'." },
          team: { type: "string", description: "Team name. Defaults to 'Voice team'." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_agent",
      description: "Update the configuration of an existing voice agent (modify system prompt, change firstMessage greeting, status, or language).",
      parameters: {
        type: "object",
        properties: {
          agentNameOrId: {
            type: "string",
            description: "The name or ID of the voice agent to update.",
          },
          prompt: {
            type: "string",
            description: "Updated system instructions or behavioral prompt for the voice agent.",
          },
          firstMessage: {
            type: "string",
            description: "Updated first greeting spoken by the agent when answering.",
          },
          language: {
            type: "string",
            description: "Updated primary language (e.g. 'English', 'Hindi', 'Spanish').",
          },
          status: {
            type: "string",
            enum: ["Live", "Draft", "Paused"],
            description: "Updated status of the agent.",
          },
        },
        required: ["agentNameOrId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_calls",
      description: "Retrieve recent individual calls from the signed-in workspace. Use this whenever the user asks for a count of calls, such as 'last N calls', 'show my last 15 calls', 'summarize my calls', or recent call history. Returns callId, agent, status, duration, failure reasons, and preview.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Number of recent calls to return. Defaults to 15." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_call_summary",
      description: "Get aggregate call totals over a calendar number of DAYS. Use ONLY when the user asks for a number of days (e.g. 'last 7 days', 'last 15 days', 'past 30 days'). NEVER use this when the user asks for a count of calls (e.g. '15 calls').",
      parameters: {
        type: "object",
        properties: {
          days: { type: "integer", minimum: 1, maximum: 90, description: "How many recent calendar days to include. Defaults to 7." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_call_transcript",
      description: "Retrieve the full verbatim conversation transcript of a call (turn-by-turn dialog between caller and voice agent), along with duration, sentiment, recording URL, and caller phone number. If callId is omitted, it automatically fetches the latest call that has a transcript. You can also specify agentName to get the latest call for a particular agent.",
      parameters: {
        type: "object",
        properties: {
          callId: {
            type: "string",
            description: "The ID of the call or LiveKit room name. If omitted, the latest call with a transcript is returned.",
          },
          agentName: {
            type: "string",
            description: "Optional agent name to find the latest call handled by that specific voice agent.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_call_details",
      description: "Retrieve comprehensive technical diagnostics and metadata for a specific call (or latest call), including average/P50/P90 response latency, cost breakdown (LLM, STT, TTS, carrier), error messages, SIP termination codes, and recording URL.",
      parameters: {
        type: "object",
        properties: {
          callId: {
            type: "string",
            description: "The ID of the call or LiveKit room name. If omitted, details for the latest call are returned.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_phone_numbers",
      description: "List all active, pending, or configured phone numbers in this workspace, showing their assigned voice agents, provider, monthly fee, and operational status.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_campaigns",
      description: "List recent outbound campaigns in this workspace so a specific campaign can be selected.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_campaign_performance",
      description: "Analyze a campaign's real lead outcomes, call statuses and recent failure reasons. If no campaign is specified, use the latest campaign.",
      parameters: { type: "object", properties: {
        campaignNameOrId: { type: "string", description: "Optional campaign name or ID." },
      }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_follow_up_candidates",
      description: "Find campaign contacts with follow-up or qualified outcomes that have no active callback, scheduled follow-up, or verified conversion. These are review candidates, not automatically approved calls.",
      parameters: { type: "object", properties: {
        campaignNameOrId: { type: "string", description: "Optional campaign name or ID. Omit to search the workspace." },
      }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_follow_up",
      description: "Prepare a callback for a specific campaign lead. Requires an exact ISO date and time with UTC offset, within that campaign's calling window. Returns a review card; the call is scheduled only after explicit user approval. Use get_follow_up_candidates first to obtain the leadId and campaign timezone.",
      parameters: { type: "object", properties: {
        leadId: { type: "string", description: "Campaign lead ID from get_follow_up_candidates." },
        scheduledAt: { type: "string", description: "Exact ISO datetime including UTC offset, e.g. 2026-10-26T10:00:00+05:30." },
        reason: { type: "string", description: "Short reason for the follow-up." },
      }, required: ["leadId", "scheduledAt"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_agent_performance",
      description: "Get actual call status, duration, latency and recent failure evidence for a voice agent, to ground improvement recommendations.",
      parameters: { type: "object", properties: {
        agentNameOrId: { type: "string", description: "Voice agent name or ID." },
        days: { type: "integer", minimum: 1, maximum: 90, description: "Recent days to analyze. Defaults to 30." },
      }, required: ["agentNameOrId"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "search_agent_knowledge",
      description: "Search indexed knowledge documents for a specific voice agent and return short source excerpts.",
      parameters: { type: "object", properties: {
        agentNameOrId: { type: "string", description: "Voice agent name or ID." },
        query: { type: "string", description: "What to look up in the agent's knowledge sources." },
      }, required: ["agentNameOrId", "query"], additionalProperties: false },
    },
  },
] as const;

async function assertAssistantReadAccess(organizationId: string, feature?: "advancedAnalytics" | "campaigns" | "knowledgeBase") {
  if (!Types.ObjectId.isValid(organizationId)) throw new HttpError(401, "Workspace access is required.");
  if (!env.whiteLabelEnabled) return;
  const organization = await OrganizationModel.findById(organizationId)
    .select("whiteLabelAccountId whiteLabelBrandId")
    .lean();
  if (!organization?.whiteLabelAccountId) return;
  const subscription = await WhiteLabelSubscriptionModel.findOne({
    orgId: organizationId,
    accountId: String(organization.whiteLabelAccountId),
    brandId: String(organization.whiteLabelBrandId ?? ""),
    status: { $in: ["trialing", "active", "past_due", "paused"] },
  }).select("featuresSnapshot").lean();
  if (!subscription) throw new HttpError(402, "No active white-label subscription is assigned to this workspace.");
  const features = subscription.featuresSnapshot as Record<string, unknown> | undefined;
  if (feature && features?.[feature] !== true) {
    throw new HttpError(403, "Advanced analytics is not included in this workspace plan.");
  }
}

export async function runAssistantTool(
  organizationId: string,
  name: string,
  rawArguments: string,
) {
  let argumentsValue: Record<string, unknown> = {};
  if (rawArguments && rawArguments.trim()) {
    try {
      const parsed = JSON.parse(rawArguments);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        argumentsValue = parsed as Record<string, unknown>;
      } else {
        throw new Error();
      }
    } catch {
      throw new HttpError(400, "The assistant supplied invalid tool arguments.");
    }
  }

  if (["list_campaigns", "get_campaign_performance", "get_follow_up_candidates", "get_agent_performance", "search_agent_knowledge"].includes(name)) {
    await assertAssistantReadAccess(organizationId,
      name === "search_agent_knowledge" ? "knowledgeBase"
        : name === "get_agent_performance" ? "advancedAnalytics" : "campaigns");
    if (name === "list_campaigns") return listAssistantCampaigns(organizationId);
    if (name === "get_campaign_performance") {
      return getAssistantCampaignPerformance(organizationId, String(argumentsValue.campaignNameOrId ?? "").slice(0, 160));
    }
    if (name === "get_follow_up_candidates") {
      return getAssistantFollowUpCandidates(organizationId, String(argumentsValue.campaignNameOrId ?? "").slice(0, 160));
    }
    const agentNameOrId = String(argumentsValue.agentNameOrId ?? "").trim();
    if (!agentNameOrId || agentNameOrId.length > 120) throw new HttpError(400, "A valid voice agent name or ID is required.");
    if (name === "get_agent_performance") {
      const days = Number(argumentsValue.days ?? 30);
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new HttpError(400, "Choose a range from 1 to 90 days.");
      return getAssistantAgentPerformance(organizationId, agentNameOrId, days);
    }
    const query = String(argumentsValue.query ?? "").trim();
    if (!query || query.length > 500) throw new HttpError(400, "A knowledge search needs a question of up to 500 characters.");
    return searchAssistantKnowledge(organizationId, agentNameOrId, query);
  }

  if (name === "list_agents") {
    await assertAssistantReadAccess(organizationId);
    const agents = await VoiceAgentModel.find({ ownerId: organizationId })
      .select("name team status language voice phone prompt createdAt")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    return agents.map((agent) => ({
      id: String(agent._id),
      name: agent.name,
      team: agent.team,
      status: agent.status,
      language: agent.language,
      voice: agent.voice,
      hasPhoneNumber: Boolean(agent.phone),
      phoneNumber: agent.phone || null,
      promptPreview: agent.prompt ? (agent.prompt.length > 120 ? `${agent.prompt.slice(0, 117)}...` : agent.prompt) : "",
    }));
  }

  if (name === "get_agent_details") {
    const identifier = String(argumentsValue.agentNameOrId ?? "").trim();
    if (!identifier) throw new HttpError(400, "An agent name or ID is required.");
    await assertAssistantReadAccess(organizationId);
    const query = Types.ObjectId.isValid(identifier)
      ? { _id: new Types.ObjectId(identifier), ownerId: organizationId }
      : { name: { $regex: new RegExp(`^${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }, ownerId: organizationId };

    let agent = await VoiceAgentModel.findOne(query).lean();
    if (!agent && !Types.ObjectId.isValid(identifier)) {
      agent = await VoiceAgentModel.findOne({
        name: { $regex: new RegExp(identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
        ownerId: organizationId,
      }).lean();
    }
    if (!agent) {
      throw new HttpError(404, `No voice agent matching '${identifier}' was found in this workspace.`);
    }

    return {
      id: String(agent._id),
      name: agent.name,
      team: agent.team,
      status: agent.status,
      language: agent.language,
      voice: agent.voice,
      phone: agent.phone || null,
      firstMessage: agent.firstMessage,
      prompt: agent.prompt,
      pipelineMode: agent.pipelineMode,
      supportedLanguages: agent.supportedLanguages,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    };
  }

  if (name === "create_agent") {
    const agentName = String(argumentsValue.name ?? "").trim();
    if (!agentName) throw new HttpError(400, "An agent name is required.");
    await assertAssistantReadAccess(organizationId);
    const prompt = String(argumentsValue.prompt ?? "").trim() || `You are ${agentName}, a concise, helpful voice assistant. Answer naturally and ask one question at a time.`;
    const firstMessage = String(argumentsValue.firstMessage ?? "").trim() || `Hi, this is ${agentName}. How can I help you today?`;
    const language = String(argumentsValue.language ?? "").trim() || "English";
    const team = String(argumentsValue.team ?? "").trim() || "Voice team";

    const created = await VoiceAgentModel.create({
      ownerId: organizationId,
      name: agentName,
      team,
      status: "Draft",
      phone: "",
      language,
      multilingualEnabled: false,
      languageSwitchingEnabled: false,
      supportedLanguages: [language],
      voice: "Puck",
      providerModel: "gemini-realtime",
      pipelineMode: "realtime",
      realtimeProvider: "gemini",
      realtimeModel: "gemini-3.1-flash-live-preview",
      llmProvider: "openai",
      llmModel: "gpt-4.1-mini",
      sttProvider: "openai",
      sttModel: "gpt-4o-mini-transcribe",
      ttsProvider: "openai",
      ttsModel: "gpt-4o-mini-tts",
      prompt,
      firstMessage,
      tools: [],
    });

    return {
      success: true,
      agentId: String(created._id),
      name: created.name,
      team: created.team,
      status: created.status,
      language: created.language,
      firstMessage: created.firstMessage,
      message: `Voice agent '${created.name}' has been created in Draft status. You can find, configure, and test it in Voice Agents.`,
    };
  }

  if (name === "update_agent") {
    const identifier = String(argumentsValue.agentNameOrId ?? "").trim();
    if (!identifier) throw new HttpError(400, "An agent name or ID is required.");
    await assertAssistantReadAccess(organizationId);
    const query = Types.ObjectId.isValid(identifier)
      ? { _id: new Types.ObjectId(identifier), ownerId: organizationId }
      : { name: { $regex: new RegExp(`^${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }, ownerId: organizationId };

    let agent = await VoiceAgentModel.findOne(query);
    if (!agent && !Types.ObjectId.isValid(identifier)) {
      agent = await VoiceAgentModel.findOne({
        name: { $regex: new RegExp(identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
        ownerId: organizationId,
      });
    }
    if (!agent) {
      throw new HttpError(404, `No voice agent matching '${identifier}' was found.`);
    }

    const updates: Record<string, unknown> = {};
    if (typeof argumentsValue.prompt === "string" && argumentsValue.prompt.trim()) {
      agent.prompt = argumentsValue.prompt.trim();
      updates.prompt = "Updated system instructions";
    }
    if (typeof argumentsValue.firstMessage === "string" && argumentsValue.firstMessage.trim()) {
      agent.firstMessage = argumentsValue.firstMessage.trim();
      updates.firstMessage = agent.firstMessage;
    }
    if (typeof argumentsValue.language === "string" && argumentsValue.language.trim()) {
      agent.language = argumentsValue.language.trim();
      updates.language = agent.language;
    }
    if (typeof argumentsValue.status === "string" && ["Live", "Draft", "Paused"].includes(argumentsValue.status)) {
      agent.status = argumentsValue.status as "Live" | "Draft" | "Paused";
      updates.status = agent.status;
    }

    await agent.save();

    return {
      success: true,
      agentId: String(agent._id),
      name: agent.name,
      status: agent.status,
      language: agent.language,
      firstMessage: agent.firstMessage,
      updatesApplied: updates,
      message: `Voice agent '${agent.name}' has been updated successfully.`,
    };
  }

  if (name === "get_call_summary") {
    const requestedDays = Number(argumentsValue.days ?? 7);
    if (!Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 90) {
      throw new HttpError(400, "Choose a call summary range from 1 to 90 days.");
    }
    await assertAssistantReadAccess(organizationId, "advancedAnalytics");
    const to = new Date();
    const from = new Date(to.getTime() - requestedDays * 24 * 60 * 60 * 1000);
    const [totals] = await CallDetailRecordModel.aggregate([
      {
        $match: {
          $or: [{ ownerId: organizationId }, { orgId: organizationId }],
          createdAt: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: null,
          totalCalls: { $sum: 1 },
          completedCalls: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          failedCalls: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          totalDurationSeconds: { $sum: "$durationSeconds" },
          averageDurationSeconds: { $avg: "$durationSeconds" },
        },
      },
    ]);

    const totalAllTime = await CallDetailRecordModel.countDocuments({
      $or: [{ ownerId: organizationId }, { orgId: organizationId }],
    });
    const latestCall = totalAllTime > 0
      ? await CallDetailRecordModel.findOne({
          $or: [{ ownerId: organizationId }, { orgId: organizationId }],
        })
          .sort({ createdAt: -1, _id: -1 })
          .select("createdAt")
          .lean()
      : null;

    return {
      days: requestedDays,
      totalCalls: totals?.totalCalls ?? 0,
      completedCalls: totals?.completedCalls ?? 0,
      failedCalls: totals?.failedCalls ?? 0,
      totalDurationSeconds: Math.round(totals?.totalDurationSeconds ?? 0),
      averageDurationSeconds: Math.round(totals?.averageDurationSeconds ?? 0),
      workspaceTotalCallsAllTime: totalAllTime,
      latestCallDate: latestCall?.createdAt ?? null,
    };
  }

  if (name === "get_recent_calls") {
    const requestedLimit = Number(argumentsValue.limit ?? 15);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
      throw new HttpError(400, "Choose between 1 and 50 recent calls.");
    }
    await assertAssistantReadAccess(organizationId);
    const calls = await CallDetailRecordModel.find({
      $or: [{ ownerId: organizationId }, { orgId: organizationId }],
    })
      .select("agentId direction status durationSeconds createdAt startedAt endReason errorMessage sentimentLabel transcript callerNumber")
      .sort({ createdAt: -1, _id: -1 })
      .limit(requestedLimit)
      .lean();

    const agentIds = [...new Set(calls.map((call) => String(call.agentId ?? "")).filter((id) => Types.ObjectId.isValid(id)))];
    const agents = await VoiceAgentModel.find({
      ownerId: organizationId,
      _id: { $in: agentIds },
    })
      .select("name")
      .lean();
    const agentNames = new Map(agents.map((agent) => [String(agent._id), agent.name]));

    return calls.map((call) => {
      let transcriptSnippet: string | undefined;
      const rawTurns = Array.isArray(call.transcript) ? call.transcript : [];
      if (rawTurns.length > 0) {
        const preview = rawTurns.slice(0, 3).map((item) => `${item.role}: ${item.text}`).join(" | ");
        transcriptSnippet = preview.length > 200 ? `${preview.slice(0, 197)}…` : preview;
      }

      return {
        callId: String(call._id),
        date: call.startedAt ?? call.createdAt,
        agent: agentNames.get(String(call.agentId)) ?? "Unknown agent",
        callerNumber: call.callerNumber || "Web / Anonymous",
        direction: call.direction,
        status: call.status,
        durationSeconds: Math.round(call.durationSeconds ?? 0),
        endReason: call.endReason || undefined,
        errorMessage: call.errorMessage || undefined,
        sentiment: call.sentimentLabel || undefined,
        hasTranscript: rawTurns.length > 0,
        transcriptSnippet,
      };
    });
  }

  if (name === "get_call_transcript") {
    await assertAssistantReadAccess(organizationId);
    const callIdArg = typeof argumentsValue.callId === "string" ? argumentsValue.callId.trim() : "";
    const agentNameArg = typeof argumentsValue.agentName === "string" ? argumentsValue.agentName.trim() : "";

    let call: any = null;

    if (callIdArg) {
      const matchCriteria = Types.ObjectId.isValid(callIdArg)
        ? [{ _id: new Types.ObjectId(callIdArg) }, { livekitRoomName: callIdArg }]
        : [{ livekitRoomName: callIdArg }];

      call = await CallDetailRecordModel.findOne({
        $or: [{ ownerId: organizationId }, { orgId: organizationId }],
        $and: [{ $or: matchCriteria }],
      }).lean();
    } else {
      let agentFilterId: Types.ObjectId | undefined;
      if (agentNameArg) {
        const agent = await VoiceAgentModel.findOne({
          ownerId: organizationId,
          name: { $regex: new RegExp(agentNameArg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
        }).select("_id").lean();
        if (agent) {
          agentFilterId = agent._id;
        }
      }

      const query: Record<string, unknown> = {
        $or: [{ ownerId: organizationId }, { orgId: organizationId }],
        "transcript.0": { $exists: true },
      };
      if (agentFilterId) {
        query.agentId = agentFilterId;
      }

      call = await CallDetailRecordModel.findOne(query)
        .sort({ createdAt: -1, _id: -1 })
        .lean();

      if (!call) {
        const anyQuery: Record<string, unknown> = {
          $or: [{ ownerId: organizationId }, { orgId: organizationId }],
        };
        if (agentFilterId) anyQuery.agentId = agentFilterId;
        const latestAny = await CallDetailRecordModel.findOne(anyQuery)
          .sort({ createdAt: -1, _id: -1 })
          .lean();

        if (!latestAny) {
          return {
            found: false,
            message: agentNameArg
              ? `No calls were found for voice agent '${agentNameArg}'.`
              : "No calls have been recorded yet in this workspace.",
          };
        }

        const agent = await VoiceAgentModel.findById(latestAny.agentId).select("name").lean();
        return {
          found: false,
          callId: String(latestAny._id),
          agentName: agent?.name ?? "Unknown agent",
          status: latestAny.status,
          date: latestAny.startedAt ?? latestAny.createdAt,
          durationSeconds: Math.round(latestAny.durationSeconds ?? 0),
          endReason: latestAny.endReason || undefined,
          errorMessage: latestAny.errorMessage || undefined,
          message: "The latest call in this workspace has no transcript recorded (e.g. call dropped before audio exchange or had zero duration).",
        };
      }
    }

    if (!call) {
      throw new HttpError(404, `Call '${callIdArg}' was not found in this workspace.`);
    }

    const agent = await VoiceAgentModel.findById(call.agentId).select("name").lean();
    const rawTurns = Array.isArray(call.transcript) ? call.transcript : [];
    const formattedTurns = rawTurns.map((item: any) => ({
      speaker: item.role === "user" ? "Caller" : item.role === "assistant" ? "Agent" : "System",
      text: item.text,
      time: item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : undefined,
      interrupted: item.interrupted || undefined,
    }));

    return {
      found: true,
      callId: String(call._id),
      agentName: agent?.name ?? "Unknown agent",
      direction: call.direction,
      status: call.status,
      callerNumber: call.callerNumber || "Web / Anonymous",
      calledNumber: call.calledNumber || undefined,
      durationSeconds: Math.round(call.durationSeconds ?? 0),
      date: call.startedAt ?? call.createdAt,
      sentiment: call.sentimentLabel || undefined,
      sentimentScore: call.sentimentScore ?? undefined,
      recordingUrl: call.recordingUrl || undefined,
      endReason: call.endReason || undefined,
      totalTurns: formattedTurns.length,
      transcript: formattedTurns,
    };
  }

  if (name === "get_call_details") {
    await assertAssistantReadAccess(organizationId);
    const callIdArg = typeof argumentsValue.callId === "string" ? argumentsValue.callId.trim() : "";
    let call: any = null;

    if (callIdArg) {
      const matchCriteria = Types.ObjectId.isValid(callIdArg)
        ? [{ _id: new Types.ObjectId(callIdArg) }, { livekitRoomName: callIdArg }]
        : [{ livekitRoomName: callIdArg }];

      call = await CallDetailRecordModel.findOne({
        $or: [{ ownerId: organizationId }, { orgId: organizationId }],
        $and: [{ $or: matchCriteria }],
      }).lean();
    } else {
      call = await CallDetailRecordModel.findOne({
        $or: [{ ownerId: organizationId }, { orgId: organizationId }],
      })
        .sort({ createdAt: -1, _id: -1 })
        .lean();
    }

    if (!call) {
      throw new HttpError(404, "No call record was found in this workspace.");
    }

    const agent = await VoiceAgentModel.findById(call.agentId).select("name").lean();

    return {
      callId: String(call._id),
      agentName: agent?.name ?? "Unknown agent",
      direction: call.direction,
      status: call.status,
      callerNumber: call.callerNumber || "Web / Anonymous",
      calledNumber: call.calledNumber || undefined,
      durationSeconds: Math.round(call.durationSeconds ?? 0),
      date: call.startedAt ?? call.createdAt,
      endReason: call.endReason || "Normal completion",
      errorMessage: call.errorMessage || null,
      recordingUrl: call.recordingUrl || null,
      recordingStatus: call.recordingStatus || "none",
      latency: {
        avgResponseLatencyMs: Math.round(call.avgResponseLatencyMs ?? 0),
        p50Ms: Math.round(call.responseLatencyP50Ms ?? 0),
        p90Ms: Math.round(call.responseLatencyP90Ms ?? 0),
      },
      costBreakdown: {
        llm: call.costBreakdown?.llm ?? 0,
        stt: call.costBreakdown?.stt ?? 0,
        tts: call.costBreakdown?.tts ?? 0,
        telephony: call.costBreakdown?.telephony ?? 0,
        platformFee: call.costBreakdown?.platformFee ?? 0,
        total: call.costBreakdown?.total ?? 0,
        currency: call.costBreakdown?.currency ?? "USD",
      },
      providers: {
        pipelineMode: call.pipelineMode,
        realtimeProvider: call.realtimeProvider || undefined,
        realtimeModel: call.realtimeModel || undefined,
        llmModel: call.llmModel || undefined,
        ttsVoice: call.ttsVoice || undefined,
      },
      sentiment: call.sentimentLabel || undefined,
    };
  }

  if (name === "list_phone_numbers") {
    await assertAssistantReadAccess(organizationId);
    const phones = await PhoneNumberModel.find({
      ownerId: organizationId,
      lifecycle: { $ne: "deleting" },
    })
      .sort({ createdAt: -1 })
      .lean();

    const agentIds = [...new Set(phones.map((p) => String(p.agentId ?? "")).filter((id) => Types.ObjectId.isValid(id)))];
    const agents = await VoiceAgentModel.find({
      ownerId: organizationId,
      _id: { $in: agentIds },
    })
      .select("name")
      .lean();
    const agentMap = new Map(agents.map((a) => [String(a._id), a.name]));

    return phones.map((p) => ({
      number: p.number,
      label: p.label,
      status: p.status,
      direction: p.direction,
      provider: p.provider,
      assignedAgent: agentMap.get(String(p.agentId)) ?? "Unassigned",
      monthlyFee: p.monthlyFee,
      currency: p.currency,
    }));
  }

  throw new HttpError(400, "That Vozon assistant action is not available.");
}
