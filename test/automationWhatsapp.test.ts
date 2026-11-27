import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { env } from "../src/config/env.js";
import { whatsAppTemplateIssues, type AutomationNode } from "../src/services/automationDefinitionService.js";
import { fetchWhatsAppMediaBytes, getWhatsAppAppWebhookSubscriptionStatus, getWhatsAppTemplate, triggerCoexistenceSync } from "../src/services/whatsappService.js";
import { verifyWhatsAppSignature } from "../src/services/automationWhatsAppStatusService.js";
import {
  createDedupedWhatsAppMessage,
  findWhatsAppConversationForLine,
  processCoexistenceHistory,
  processCoexistenceStateSync,
  upsertCoexistenceEcho,
} from "../src/services/whatsappCoexistenceService.js";
import { WhatsAppContactModel, WhatsAppConversationModel, WhatsAppMessageModel } from "../src/models/WhatsAppEntities.js";

const node: AutomationNode = {
  id: "message", type: "whatsapp", title: "Send brochure", x: 0, y: 0,
  config: { templateName: "brochure", language: "en_US", bodyVariables: "{{name}},{{phone}}" },
};

test("WhatsApp webhook signature uses the exact raw body", () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
  assert.equal(verifyWhatsAppSignature(body, signature, "test-secret"), true);
  assert.equal(verifyWhatsAppSignature(Buffer.from(`${body} `), signature, "test-secret"), false);
  assert.equal(verifyWhatsAppSignature(body, signature, "wrong-secret"), false);
  assert.equal(verifyWhatsAppSignature(body, "", "test-secret"), false);
});

test("Meta template lookup selects the requested language and keeps the token in a header", async (context) => {
  context.mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, `/${env.whatsappApiVersion}/123456789/message_templates`);
    assert.equal(url.searchParams.get("name"), "brochure");
    assert.equal(url.searchParams.get("fields"), "name,language,status,components");
    assert.ok(!url.toString().includes("secret"));
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer secret");
    return new Response(JSON.stringify({ data: [
      { name: "brochure", language: "hi_IN", status: "APPROVED", components: [] },
      { name: "brochure", language: "en_US", status: "APPROVED", components: [{ type: "BODY", text: "Hi {{1}}, call {{2}}" }] },
    ] }), { status: 200 });
  });
  const template = await getWhatsAppTemplate("123456789", "secret", "brochure", "en_US");
  assert.equal(template?.language, "en_US");
  assert.deepEqual(whatsAppTemplateIssues(node, template!), []);
});

test("publish checks reject missing variables and unsupported dynamic headers", () => {
  const template = {
    name: "brochure", language: "en_US", status: "APPROVED",
    components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi {{1}}, call {{2}}" }],
  };
  const issues = whatsAppTemplateIssues({ ...node, config: { ...node.config, bodyVariables: "{{name}}" } }, template);
  assert.ok(issues.some((issue) => issue.message.includes("2 body variables")));
  assert.ok(issues.some((issue) => issue.message.includes("header or button parameters")));
  const dynamicButton = whatsAppTemplateIssues(node, {
    ...template,
    components: [template.components[1], { type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.com/{{1}}" }] }],
  });
  assert.ok(dynamicButton.some((issue) => issue.message.includes("header or button parameters")));
});

test("triggerCoexistenceSync requests smb_app_state_sync and history on smb_app_data", async (context) => {
  const calls: Array<{ pathname: string; syncType: string }> = [];
  context.mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const parsed = JSON.parse(String(init?.body || "{}")) as { sync_type?: string };
    calls.push({ pathname: url.pathname, syncType: String(parsed.sync_type || "") });
    if (parsed.sync_type === "history") {
      return new Response(JSON.stringify({ error: { message: "History sync already requested" } }), { status: 400 });
    }
    return new Response(JSON.stringify({ success: true, request_id: "req_1" }), { status: 200 });
  });

  const result = await triggerCoexistenceSync("987654321", "token-123");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.pathname === `/${env.whatsappApiVersion}/987654321/smb_app_data`));
  assert.equal(result.contactsSyncRequested, true);
  assert.equal(result.historySyncRequested, false);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].includes("history:"));
});

test("getWhatsAppAppWebhookSubscriptionStatus reports missing coexistence fields", async (context) => {
  const prevAppId = env.metaAppId;
  const prevSecret = env.metaAppSecret;
  const prevBackendUrl = env.backendPublicUrl;
  env.metaAppId = "123456";
  env.metaAppSecret = "secret-xyz";
  env.backendPublicUrl = "https://api.example.com";

  try {
    context.mock.method(globalThis, "fetch", async () => {
      return new Response(JSON.stringify({
        data: [
          {
            object: "whatsapp_business_account",
            active: true,
            callback_url: "https://api.example.com/api/webhooks/whatsapp",
            fields: ["messages", "smb_message_echoes"],
          },
        ],
      }), { status: 200 });
    });

    const status = await getWhatsAppAppWebhookSubscriptionStatus(true);
    assert.equal(status.subscribed, true);
    assert.equal(status.coexistenceSubscribed, false);
    assert.deepEqual(status.missingCoexistenceFields, ["smb_app_state_sync", "history"]);
  } finally {
    env.metaAppId = prevAppId;
    env.metaAppSecret = prevSecret;
    env.backendPublicUrl = prevBackendUrl;
  }
});

test("coexistence ingestion handles mobile echoes, smb_app_state_sync, and history", async (context) => {
  const createdMessages: Array<Record<string, unknown>> = [];
  const contactUpserts: Array<Record<string, unknown>> = [];
  let savedConversation: Record<string, unknown> | null = null;

  context.mock.method(WhatsAppMessageModel, "exists", async () => null);
  context.mock.method(WhatsAppMessageModel, "create", async (doc: Record<string, unknown>) => {
    createdMessages.push(doc);
    return doc;
  });
  context.mock.method(WhatsAppContactModel, "findOneAndUpdate", async (_filter: unknown, update: Record<string, unknown>) => {
    contactUpserts.push(update);
    return {};
  });
  context.mock.method(WhatsAppConversationModel, "findOne", async () => savedConversation);
  context.mock.method(WhatsAppConversationModel, "create", async (doc: Record<string, unknown>) => {
    savedConversation = {
      ...doc,
      _id: "conv_1",
      save: async () => undefined,
    };
    return savedConversation;
  });
  context.mock.method(WhatsAppConversationModel, "updateMany", async () => ({ modifiedCount: 1 }));

  await upsertCoexistenceEcho({
    ownerId: "org_1",
    phoneNumberId: "phone_1",
    displayPhoneNumber: "919999888877",
    contactsList: [{ wa_id: "919876543210", profile: { name: "Jane Doe" } }],
    echo: {
      from: "919999888877",
      to: "919876543210",
      id: "wamid.echo1",
      timestamp: "1739321024",
      type: "audio",
      audio: { voice: true },
    },
    isHistory: false,
  });

  await processCoexistenceStateSync("org_1", [
    { action: "ADD", wa_id: "919876543210", first_name: "Jane", last_name: "Doe" },
  ]);

  await processCoexistenceHistory({
    ownerId: "org_1",
    phoneNumberId: "phone_1",
    displayPhoneNumber: "919999888877",
    contactsList: [{ wa_id: "919876543210", profile: { name: "Jane Doe" } }],
    threads: [
      {
        peer_recipient_id: "919876543210",
        messages: [
          { from: "919876543210", id: "wamid.hist_in", timestamp: "1738796547", type: "text", text: { body: "Past question" } },
        ],
        message_echoes: [
          { to: "919876543210", id: "wamid.hist_out", timestamp: "1738796600", type: "text", text: { body: "Past reply" } },
        ],
      },
    ],
  });

  assert.equal(createdMessages.length, 3);
  assert.equal(createdMessages[0]?.metaMessageId, "wamid.echo1");
  assert.equal(createdMessages[0]?.type, "text");
  assert.equal(createdMessages[0]?.content, "🎙️ [Voice Note]");
  assert.equal(createdMessages[0]?.senderPhone, "919999888877 (Mobile App)");
  assert.equal(createdMessages[1]?.metaMessageId, "wamid.hist_in");
  assert.equal(createdMessages[1]?.direction, "inbound");
  assert.equal(createdMessages[2]?.metaMessageId, "wamid.hist_out");
  assert.equal(createdMessages[2]?.direction, "outbound");
  assert.equal(savedConversation?.["mode"], "human");
  assert.equal(savedConversation?.["recipientPhoneNumberId"], "phone_1");
  assert.ok(contactUpserts.length >= 2);
});

test("coexistence edit and revoke echoes update the original message and mediaId is saved", async (context) => {
  const createdMessages: Array<Record<string, unknown>> = [];
  const updates: Array<{ filter: unknown; update: unknown }> = [];
  const convUpdates: Array<{ filter: unknown; update: unknown }> = [];

  context.mock.method(WhatsAppMessageModel, "exists", async () => null);
  context.mock.method(WhatsAppMessageModel, "create", async (doc: Record<string, unknown>) => {
    createdMessages.push(doc);
    return doc;
  });
  context.mock.method(WhatsAppMessageModel, "findOneAndUpdate", async (filter: unknown, update: unknown) => {
    updates.push({ filter, update });
    return { conversationId: "conv_99" };
  });
  context.mock.method(WhatsAppContactModel, "findOneAndUpdate", async () => ({}));
  context.mock.method(WhatsAppConversationModel, "findOne", async () => ({
    _id: "conv_99",
    tags: [],
    save: async () => undefined,
  }));
  context.mock.method(WhatsAppConversationModel, "updateOne", async (filter: unknown, update: unknown) => {
    convUpdates.push({ filter, update });
    return { modifiedCount: 1 };
  });

  await upsertCoexistenceEcho({
    ownerId: "org_1",
    phoneNumberId: "phone_1",
    displayPhoneNumber: "919999888877",
    contactsList: [],
    echo: {
      from: "919999888877",
      to: "919876543210",
      id: "wamid.img1",
      timestamp: "1739321024",
      type: "image",
      image: { id: "9988776655", mime_type: "image/jpeg", caption: "Menu" },
    },
    isHistory: false,
  });

  await upsertCoexistenceEcho({
    ownerId: "org_1",
    phoneNumberId: "phone_1",
    displayPhoneNumber: "919999888877",
    contactsList: [],
    echo: {
      from: "919999888877",
      to: "919876543210",
      timestamp: "1739321050",
      edit: { original_message_id: "wamid.img1", message: { type: "text", text: { body: "Updated text" } } },
    },
    isHistory: false,
  });

  await upsertCoexistenceEcho({
    ownerId: "org_1",
    phoneNumberId: "phone_1",
    displayPhoneNumber: "919999888877",
    contactsList: [],
    echo: {
      from: "919999888877",
      to: "919876543210",
      timestamp: "1739321090",
      revoke: { original_message_id: "wamid.img1" },
    },
    isHistory: false,
  });

  assert.equal(createdMessages.length, 1);
  assert.equal(createdMessages[0]?.mediaId, "9988776655");
  assert.equal(createdMessages[0]?.mediaMimeType, "image/jpeg");
  assert.equal(updates.length, 2);
  assert.equal(convUpdates.length, 2);
});

test("findWhatsAppConversationForLine isolates threads by phoneNumberId and dedupe tolerates 11000", async (context) => {
  const queries: Array<Record<string, unknown>> = [];
  context.mock.method(WhatsAppConversationModel, "findOne", async (q: Record<string, unknown>) => {
    queries.push(q);
    return null;
  });

  await findWhatsAppConversationForLine("org_1", "919876543210", "line_B");
  assert.equal(queries[0]?.recipientPhoneNumberId, "line_B");
  assert.ok(Array.isArray(queries[1]?.$or));

  context.mock.method(WhatsAppMessageModel, "exists", async () => null);
  context.mock.method(WhatsAppMessageModel, "create", async () => {
    const err = new Error("duplicate") as Error & { code?: number };
    err.code = 11000;
    throw err;
  });
  const inserted = await createDedupedWhatsAppMessage({ ownerId: "org_1", metaMessageId: "wamid.dup" });
  assert.equal(inserted, false);
});

test("fetchWhatsAppMediaBytes resolves Graph media URL and downloads bytes securely", async (context) => {
  context.mock.method(globalThis, "fetch", async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes("lookaside.fbsbx.com")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    return new Response(JSON.stringify({ url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/123", mime_type: "image/png" }), {
      status: 200,
    });
  });

  const media = await fetchWhatsAppMediaBytes("1234567890", "secret-token");
  assert.equal(media.contentType, "image/png");
  assert.deepEqual([...media.buffer], [1, 2, 3]);
});
