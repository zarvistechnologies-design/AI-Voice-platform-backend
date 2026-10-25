import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { isValidObjectId } from "mongoose";

import type { AuthenticatedRequest } from "../middleware/auth.js";
import { AgentWorkflowModel } from "../models/AgentWorkflow.js";
import { HttpError } from "../utils/httpError.js";

const nodeTypes = new Set(["trigger", "agent", "condition", "tool", "action", "handoff", "wait", "end"]);

type SafeNode = {
  nodeId: string;
  type: string;
  position: { x: number; y: number };
  data: { label: string; description: string; config: Record<string, unknown> };
};

type SafeEdge = {
  edgeId: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  label: string;
};

function ownerId(request: AuthenticatedRequest) {
  if (!request.user || !request.organization) throw new HttpError(401, "Authentication required.");
  return request.organization.id;
}

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function number(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanNodes(value: unknown): SafeNode[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 100) throw new HttpError(400, "A workflow can contain up to 100 nodes.");
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    const item = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
    const rawData = item.data && typeof item.data === "object" ? item.data as Record<string, unknown> : {};
    const rawPosition = item.position && typeof item.position === "object" ? item.position as Record<string, unknown> : {};
    const type = text(item.type, 40);
    const nodeId = text(item.id ?? item.nodeId, 120) || `node-${index + 1}`;
    if (!nodeTypes.has(type)) throw new HttpError(400, `Unsupported workflow node type: ${type || "empty"}.`);
    if (ids.has(nodeId)) throw new HttpError(400, `Duplicate workflow node id: ${nodeId}.`);
    ids.add(nodeId);
    const config = rawData.config && typeof rawData.config === "object" && !Array.isArray(rawData.config)
      ? rawData.config as Record<string, unknown>
      : {};
    return {
      nodeId,
      type,
      position: { x: number(rawPosition.x), y: number(rawPosition.y) },
      data: {
        label: text(rawData.label, 120) || `Untitled ${type}`,
        description: text(rawData.description, 1000),
        config,
      },
    };
  });
}

function cleanEdges(value: unknown): SafeEdge[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 200) throw new HttpError(400, "A workflow can contain up to 200 connections.");
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    const item = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
    const edgeId = text(item.id ?? item.edgeId, 120) || `edge-${index + 1}`;
    if (ids.has(edgeId)) throw new HttpError(400, `Duplicate workflow connection id: ${edgeId}.`);
    ids.add(edgeId);
    return {
      edgeId,
      source: text(item.source, 120),
      target: text(item.target, 120),
      sourceHandle: text(item.sourceHandle, 80),
      targetHandle: text(item.targetHandle, 80),
      label: text(item.label, 120),
    };
  });
}

function validateGraph(nodes: SafeNode[], edges: SafeEdge[]) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  const triggers = nodes.filter((node) => node.type === "trigger");
  if (nodes.length === 0) errors.push("Add at least one node.");
  if (triggers.length !== 1) errors.push("A workflow must have exactly one trigger.");
  if (!nodes.some((node) => node.type === "end")) warnings.push("Add an End node so successful completion is explicit.");
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) errors.push(`Connection ${edge.edgeId} points to a missing node.`);
    if (edge.source === edge.target) errors.push(`Connection ${edge.edgeId} cannot loop to the same node.`);
  }
  for (const node of nodes) {
    const incoming = edges.filter((edge) => edge.target === node.nodeId).length;
    const outgoing = edges.filter((edge) => edge.source === node.nodeId).length;
    if (node.type !== "trigger" && incoming === 0) warnings.push(`${node.data.label} is not connected to an earlier step.`);
    if (node.type !== "end" && outgoing === 0) warnings.push(`${node.data.label} has no next step.`);
    if (node.type === "condition" && outgoing < 2) warnings.push(`${node.data.label} should have at least two branches.`);
  }
  if (triggers.length === 1) {
    const reachable = new Set([triggers[0].nodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) {
        if (reachable.has(edge.source) && !reachable.has(edge.target)) {
          reachable.add(edge.target);
          changed = true;
        }
      }
    }
    const unreachable = nodes.filter((node) => !reachable.has(node.nodeId));
    if (unreachable.length) warnings.push(`${unreachable.length} node${unreachable.length === 1 ? " is" : "s are"} unreachable from the trigger.`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

function serialize(workflow: Record<string, unknown>) {
  return {
    ...workflow,
    nodes: Array.isArray(workflow.nodes) ? workflow.nodes.map((node) => {
      const item = node as Record<string, unknown>;
      return { id: item.nodeId, type: item.type, position: item.position, data: item.data };
    }) : [],
    edges: Array.isArray(workflow.edges) ? workflow.edges.map((edge) => {
      const item = edge as Record<string, unknown>;
      return { id: item.edgeId, source: item.source, target: item.target, sourceHandle: item.sourceHandle, targetHandle: item.targetHandle, label: item.label };
    }) : [],
  };
}

function workflowId(request: AuthenticatedRequest) {
  const id = request.params.workflowId;
  if (!isValidObjectId(id)) throw new HttpError(404, "Workflow not found.");
  return id;
}

export async function listWorkflows(request: AuthenticatedRequest, response: Response) {
  const workflows = await AgentWorkflowModel.find({ ownerId: ownerId(request) })
    .sort({ updatedAt: -1 })
    .select("name description status version publishedVersion nodes edges updatedAt createdAt lastPublishedAt runs")
    .lean();
  response.json({ workflows: workflows.map((workflow) => ({
    ...workflow,
    nodeCount: workflow.nodes.length,
    edgeCount: workflow.edges.length,
    runCount: workflow.runs.length,
    nodes: undefined,
    edges: undefined,
    runs: undefined,
  })) });
}

export async function createWorkflow(request: AuthenticatedRequest, response: Response) {
  const nodes = cleanNodes(request.body?.nodes);
  const edges = cleanEdges(request.body?.edges);
  const workflow = await AgentWorkflowModel.create({
    ownerId: ownerId(request),
    name: text(request.body?.name, 120) || "Untitled workflow",
    description: text(request.body?.description, 1000),
    nodes,
    edges,
    variables: request.body?.variables && typeof request.body.variables === "object" ? request.body.variables : {},
  });
  response.status(201).json({ workflow: serialize(workflow.toObject() as unknown as Record<string, unknown>) });
}

export async function getWorkflow(request: AuthenticatedRequest, response: Response) {
  const workflow = await AgentWorkflowModel.findOne({ _id: workflowId(request), ownerId: ownerId(request) }).lean();
  if (!workflow) throw new HttpError(404, "Workflow not found.");
  response.json({ workflow: serialize(workflow as unknown as Record<string, unknown>) });
}

export async function updateWorkflow(request: AuthenticatedRequest, response: Response) {
  const nodes = cleanNodes(request.body?.nodes);
  const edges = cleanEdges(request.body?.edges);
  const workflow = await AgentWorkflowModel.findOne({ _id: workflowId(request), ownerId: ownerId(request) });
  if (!workflow) throw new HttpError(404, "Workflow not found.");
  workflow.name = text(request.body?.name, 120) || workflow.name;
  workflow.description = text(request.body?.description, 1000);
  workflow.nodes = nodes as never;
  workflow.edges = edges as never;
  workflow.variables = request.body?.variables && typeof request.body.variables === "object" ? request.body.variables : {};
  workflow.version += 1;
  await workflow.save();
  response.json({ workflow: serialize(workflow.toObject() as unknown as Record<string, unknown>), validation: validateGraph(nodes, edges) });
}

export async function validateWorkflow(request: AuthenticatedRequest, response: Response) {
  const nodes = cleanNodes(request.body?.nodes);
  const edges = cleanEdges(request.body?.edges);
  response.json({ validation: validateGraph(nodes, edges) });
}

export async function publishWorkflow(request: AuthenticatedRequest, response: Response) {
  const workflow = await AgentWorkflowModel.findOne({ _id: workflowId(request), ownerId: ownerId(request) });
  if (!workflow) throw new HttpError(404, "Workflow not found.");
  const nodes = cleanNodes(workflow.nodes.map((node) => ({ id: node.nodeId, type: node.type, position: node.position, data: node.data })));
  const edges = cleanEdges(workflow.edges.map((edge) => ({ id: edge.edgeId, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle, label: edge.label })));
  const validation = validateGraph(nodes, edges);
  if (!validation.valid) throw new HttpError(400, validation.errors.join(" "));
  workflow.status = "live";
  workflow.publishedVersion = workflow.version;
  workflow.lastPublishedAt = new Date();
  await workflow.save();
  response.json({ workflow: serialize(workflow.toObject() as unknown as Record<string, unknown>), validation });
}

export async function pauseWorkflow(request: AuthenticatedRequest, response: Response) {
  const workflow = await AgentWorkflowModel.findOneAndUpdate(
    { _id: workflowId(request), ownerId: ownerId(request) },
    { $set: { status: "paused" } },
    { new: true },
  ).lean();
  if (!workflow) throw new HttpError(404, "Workflow not found.");
  response.json({ workflow: serialize(workflow as unknown as Record<string, unknown>) });
}

export async function runWorkflowTest(request: AuthenticatedRequest, response: Response) {
  const workflow = await AgentWorkflowModel.findOne({ _id: workflowId(request), ownerId: ownerId(request) });
  if (!workflow) throw new HttpError(404, "Workflow not found.");
  const nodes = cleanNodes(workflow.nodes.map((node) => ({ id: node.nodeId, type: node.type, position: node.position, data: node.data })));
  const edges = cleanEdges(workflow.edges.map((edge) => ({ id: edge.edgeId, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle, label: edge.label })));
  const validation = validateGraph(nodes, edges);
  if (!validation.valid) throw new HttpError(400, validation.errors.join(" "));
  const startedAt = new Date();
  const timeline: Array<Record<string, unknown>> = [];
  const visited = new Set<string>();
  let current = nodes.find((node) => node.type === "trigger") ?? null;
  for (let step = 0; current && step < 50; step += 1) {
    if (visited.has(current.nodeId)) {
      timeline.push({ nodeId: current.nodeId, label: current.data.label, type: current.type, status: "failed", detail: "Loop detected during test." });
      break;
    }
    visited.add(current.nodeId);
    timeline.push({ nodeId: current.nodeId, label: current.data.label, type: current.type, status: "completed", detail: current.data.description || `Completed ${current.type} step.` });
    const outgoing = edges.filter((edge) => edge.source === current?.nodeId);
    const selected = current.type === "condition"
      ? outgoing.find((edge) => edge.label.toLowerCase() === text(request.body?.branch, 120).toLowerCase()) ?? outgoing[0]
      : outgoing[0];
    current = selected ? nodes.find((node) => node.nodeId === selected.target) ?? null : null;
  }
  const completedAt = new Date();
  const run = { runId: randomUUID(), status: "completed" as const, startedAt, completedAt, input: request.body?.input ?? {}, timeline };
  workflow.runs = [run as never, ...workflow.runs].slice(0, 30) as never;
  await workflow.save();
  response.json({ run, validation });
}

export async function deleteWorkflow(request: AuthenticatedRequest, response: Response) {
  const workflow = await AgentWorkflowModel.findOneAndDelete({ _id: workflowId(request), ownerId: ownerId(request) });
  if (!workflow) throw new HttpError(404, "Workflow not found.");
  response.json({ ok: true });
}
