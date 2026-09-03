import assert from "node:assert/strict";
import test from "node:test";

import { VoiceAgentModel } from "../src/models/VoiceAgent.js";
import { executeWebhookTool } from "../src/services/agentToolService.js";
import {
  digitalBotAppointmentWebhookKind,
  digitalBotToolActivationPlan,
  removeDigitalBotManagedTools,
  stripDigitalBotAppointmentInstruction,
} from "../src/services/digitalBotToolPolicy.js";
import { digitalbotToolDefinitions } from "../src/services/integrationService.js";

test("new agents start without tools", () => {
  const agent = new VoiceAgentModel({
    ownerId: "future-owner",
    name: "Future agent",
    team: "Voice team",
    prompt: "Help the caller.",
    firstMessage: "Hello.",
  });

  assert.deepEqual(agent.tools, []);
});

test("DigitalBot activation preserves manual tools and never duplicates appointment kinds", () => {
  const manualTools = [
    {
      name: "clinic_slots",
      url: "https://mcp-server-61zc.onrender.com/api/availability",
      managedBy: "",
    },
    {
      name: "book_appointment",
      url: "https://mcp-server-61zc.onrender.com/api/book-appointment",
      managedBy: "",
    },
    { name: "manual_crm_lookup", url: "https://example.com/crm", managedBy: "" },
  ];
  const definitions = digitalbotToolDefinitions();
  const activation = digitalBotToolActivationPlan(manualTools, definitions);

  assert.equal(activation.missingDefinitions.length, 0);
  assert.deepEqual(activation.tools, manualTools);

  const withManagedTools = [...manualTools, ...definitions];
  assert.deepEqual(removeDigitalBotManagedTools(withManagedTools), manualTools);
  assert.equal(
    stripDigitalBotAppointmentInstruction(
      "<!-- VOZON_DIGITALBOT_APPOINTMENT_INSTRUCTIONS_START -->managed<!-- VOZON_DIGITALBOT_APPOINTMENT_INSTRUCTIONS_END -->\nManual prompt",
    ),
    "Manual prompt",
  );
});

test("DigitalBot owns connector definitions and Vozon rejects malformed schemas", () => {
  const remote = digitalbotToolDefinitions().map((tool) => ({
    ...tool,
    url: `https://digitalbot.example${new URL(tool.url).pathname}`,
    description: `DigitalBot: ${tool.description}`,
    headers: { ...tool.headers },
    messages: ["Connector supplied filler should not be enabled by default."],
    parameters: tool.parameters.map((parameter) => ({ ...parameter })),
  }));
  const accepted = digitalbotToolDefinitions(remote);
  assert.ok(accepted.every((tool) => tool.url.startsWith("https://digitalbot.example/")));
  assert.ok(accepted.every((tool) => tool.description.startsWith("DigitalBot:")));
  assert.ok(accepted.every((tool) => tool.messages.length === 0));

  const malformed = structuredClone(remote);
  (malformed[0] as { method: string }).method = "GET";
  const fallback = digitalbotToolDefinitions(malformed);
  assert.ok(fallback.every((tool) => !tool.url.startsWith("https://digitalbot.example/")));
  assert.equal(
    fallback[0]?.parameters.find((parameter) => parameter.name === "date")?.type,
    "string",
  );
});

test("DigitalBot accepts hospitality workspace tool definitions from connector discovery", () => {
  const remote = [
    {
      name: "check_availability",
      description: "Check live Hotel CRM room or restaurant table availability.",
      method: "POST",
      url: "https://digital-api-46ss.onrender.com/api/hospitality/tools/check-availability",
      headers: {},
      timeoutSeconds: 15,
      parameters: [
        { name: "assignedPhoneNumber", type: "string", description: "Connected hotel phone.", required: true },
        { name: "bookingType", type: "string", description: "hotel_room or restaurant_table.", required: true },
        { name: "checkIn", type: "string", description: "Hotel check-in date.", required: false },
        { name: "checkOut", type: "string", description: "Hotel check-out date.", required: false },
        { name: "date", type: "string", description: "Restaurant booking date.", required: false },
        { name: "time", type: "string", description: "Restaurant booking time.", required: false },
        { name: "partySize", type: "number", description: "Restaurant party size.", required: false },
      ],
    },
    {
      name: "create_booking",
      description: "Create confirmed Hotel CRM room or table booking from a returned optionId.",
      method: "POST",
      url: "https://digital-api-46ss.onrender.com/api/hospitality/tools/create-booking",
      headers: {},
      timeoutSeconds: 15,
      parameters: [
        { name: "assignedPhoneNumber", type: "string", description: "Connected hotel phone.", required: true },
        { name: "bookingType", type: "string", description: "hotel_room or restaurant_table.", required: true },
        { name: "optionId", type: "string", description: "Exact optionId returned by check_availability.", required: true },
        { name: "guestName", type: "string", description: "Guest name.", required: true },
        { name: "guestPhone", type: "string", description: "Guest phone.", required: false },
      ],
    },
  ];

  const accepted = digitalbotToolDefinitions(remote);
  assert.deepEqual(accepted.map((tool) => tool.name), ["check_availability", "create_booking"]);
  assert.equal(accepted[0]?.managedBy, "digitalbot");
  assert.equal(accepted[1]?.parameters.find((parameter) => parameter.name === "optionId")?.required, true);
});

test("trusted DigitalBot endpoints work with future tool names and receive call context", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  let attempts = 0;

  globalThis.fetch = async (_input, init) => {
    attempts += 1;
    requests.push({
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    if (attempts === 1) {
      return new Response(JSON.stringify({ success: false, error: "fetch failed" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ success: true, doctors: [], diagnostic: "x".repeat(12_000) }),
      { status: 200 },
    );
  };

  try {
    const tool = {
      name: "future_clinic_schedule",
      method: "POST" as const,
      url: "https://mcp-server-61zc.onrender.com/api/availability",
      headers: { "Content-type": "application/json", "X-Clinic": "future" },
      timeoutSeconds: 3,
      excludeSessionId: true,
    };
    assert.equal(digitalBotAppointmentWebhookKind(tool), "availability");

    const result = await executeWebhookTool(
      tool,
      { date: "2026-08-17" },
      { call_id: "future-call-id", agent_id: "future-agent-id" },
    );

    assert.equal(attempts, 2);
    assert.equal(result.ok, true);
    assert.ok(result.responseText.length > 10_000);
    assert.equal(requests[1]?.headers.get("content-type"), "application/json");
    assert.equal(requests[1]?.headers.get("x-clinic"), "future");
    assert.equal(requests[1]?.body.call_id, "future-call-id");
    assert.equal(requests[1]?.body.agent_id, "future-agent-id");
    assert.equal(requests[1]?.body.date, "2026-08-17");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("booking writes are never retried", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    attempts += 1;
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ success: false, error: "temporarily unavailable" }), {
      status: 503,
    });
  };

  try {
    const result = await executeWebhookTool(
      {
        name: "future_clinic_booking",
        method: "POST",
        url: "https://mcp-server-61zc.onrender.com/api/book-appointment",
        timeoutSeconds: 3,
        excludeSessionId: true,
      },
      { patientName: "Test" },
      { call_id: "future-booking-call" },
    );

    assert.equal(result.status, 503);
    assert.equal(attempts, 1);
    assert.equal(body.call_id, "future-booking-call");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
