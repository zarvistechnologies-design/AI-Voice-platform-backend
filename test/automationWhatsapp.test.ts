import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { env } from "../src/config/env.js";
import { whatsAppTemplateIssues, type AutomationNode } from "../src/services/automationDefinitionService.js";
import { getWhatsAppTemplate } from "../src/services/whatsappService.js";
import { verifyWhatsAppSignature } from "../src/services/automationWhatsAppStatusService.js";

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
