import assert from "node:assert/strict";
import test from "node:test";
import { isPublicHttpsWebhook, normalizeAutomationGraph, validateAutomation, type AutomationGraph } from "../src/services/automationDefinitionService.js";
import { AutomationModel } from "../src/models/Automation.js";
import { simulateAutomation } from "../src/services/automationSimulationService.js";

const graph: AutomationGraph = {
  schemaVersion: 1,
  nodes: [
    { id: "start", type: "trigger", title: "Start", x: 0, y: 0, config: { event: "manual" } },
    { id: "decision", type: "decision", title: "Decide", x: 300, y: 0, config: {} },
    { id: "yes", type: "end", title: "Qualified", x: 600, y: 0, config: {} },
    { id: "later", type: "end", title: "Callback", x: 600, y: 150, config: {} },
    { id: "no", type: "end", title: "Declined", x: 600, y: 300, config: {} },
    { id: "unknown", type: "end", title: "Review", x: 600, y: 450, config: {} },
  ],
  edges: [
    { id: "a", source: "start", target: "decision", sourceHandle: "default" },
    { id: "b", source: "decision", target: "yes", sourceHandle: "interested" },
    { id: "c", source: "decision", target: "later", sourceHandle: "callback" },
    { id: "d", source: "decision", target: "no", sourceHandle: "not_interested" },
    { id: "e", source: "decision", target: "unknown", sourceHandle: "unknown" },
  ],
};

test("a complete branching workflow passes structural publish checks", async () => {
  assert.deepEqual(await validateAutomation("workspace", graph), []);
});

test("unrouted branch and cycle block publishing", async () => {
  const invalid: AutomationGraph = {
    ...graph,
    edges: [...graph.edges.filter((edge) => edge.id !== "e"), { id: "cycle", source: "yes", target: "decision", sourceHandle: "default" }],
  };
  const issues = await validateAutomation("workspace", invalid);
  assert.ok(issues.some((issue) => issue.message.includes("unknown branch")));
  assert.ok(issues.some((issue) => issue.message.includes("Loops")));
});

test("dry runs follow the selected outcome without external actions", () => {
  assert.deepEqual(simulateAutomation(graph, "qualified").map((step) => step.nodeId), ["start", "decision", "yes"]);
  assert.deepEqual(simulateAutomation(graph, "follow_up").map((step) => step.nodeId), ["start", "decision", "later"]);
  assert.deepEqual(simulateAutomation(graph, "unknown").map((step) => step.nodeId), ["start", "decision", "unknown"]);
});

test("empty step settings survive serialization and older workflows are repaired", () => {
  const document = new AutomationModel({ ownerId: "workspace", createdBy: "user", name: "Example", draft: graph });
  const stored = document.toObject().draft as AutomationGraph;
  assert.deepEqual(stored.nodes[1].config, {});

  const legacy = { ...graph, nodes: graph.nodes.map((node) => node.id === "decision" ? { ...node, config: undefined } : node) } as AutomationGraph;
  const repaired = normalizeAutomationGraph(legacy);
  assert.deepEqual(repaired.nodes[1].config, {});
  assert.deepEqual(simulateAutomation(repaired, "qualified").map((step) => step.nodeId), ["start", "decision", "yes"]);
});

test("calls require separate success and failure routes", async () => {
  const callGraph: AutomationGraph = {
    schemaVersion: 1,
    nodes: [
      { id: "start", type: "trigger", title: "Start", x: 0, y: 0, config: { event: "manual" } },
      { id: "call", type: "call", title: "Call", x: 300, y: 0, config: {} },
      { id: "success", type: "end", title: "Success", x: 600, y: 0, config: {} },
      { id: "failed", type: "end", title: "Failed", x: 600, y: 150, config: {} },
    ],
    edges: [
      { id: "a", source: "start", target: "call", sourceHandle: "default" },
      { id: "b", source: "call", target: "success", sourceHandle: "default" },
    ],
  };
  const missingRoute = await validateAutomation("workspace", callGraph);
  assert.ok(missingRoute.some((issue) => issue.nodeId === "call" && issue.message.includes("failed branch")));

  const routed = { ...callGraph, edges: [...callGraph.edges, { id: "c", source: "call", target: "failed", sourceHandle: "failed" as const }] };
  assert.deepEqual(simulateAutomation(routed, "qualified").map((step) => step.nodeId), ["start", "call", "success"]);
  assert.deepEqual(simulateAutomation(routed, "missed").map((step) => step.nodeId), ["start", "call", "failed"]);
  const issues = await validateAutomation("workspace", routed);
  assert.ok(!issues.some((issue) => issue.message.includes("failed branch")));
});

test("a stored graph with unsupported blocks fails closed", () => {
  assert.throws(() => normalizeAutomationGraph({ ...graph, nodes: [{ ...graph.nodes[0], type: "custom" }] } as AutomationGraph), /Stored workflow version is invalid/);
});

test("webhook configuration rejects local and non-HTTPS targets", () => {
  assert.equal(isPublicHttpsWebhook("https://hooks.example.com/workflow"), true);
  assert.equal(isPublicHttpsWebhook("http://hooks.example.com/workflow"), false);
  assert.equal(isPublicHttpsWebhook("https://127.0.0.1/workflow"), false);
  assert.equal(isPublicHttpsWebhook("https://service.local/workflow"), false);
});
