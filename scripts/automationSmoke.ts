import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import type { AuthenticatedRequest } from "../src/middleware/auth.js";
import {
  cancelAutomationRun, checkAutomation, createAutomation, deleteAutomation, getAutomation, getAutomationRun, listAutomationRuns,
  listAutomations, listAutomationVersions, publishAutomation, restoreAutomationVersion,
  saveAutomation, setAutomationStatus, startAutomationRun, testAutomation,
} from "../src/controllers/automationController.js";
import { AutomationRunModel } from "../src/models/Automation.js";
import { processAutomationRuns, recoverExpiredAutomationRuns } from "../src/services/automationRuntimeService.js";

// This exercises the supported manual journey in its own temporary database.
// It intentionally uses only Start and End blocks, so no provider action is sent.
const databaseName = `vzn_auto_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
const ownerId = new mongoose.Types.ObjectId().toString();
const userId = new mongoose.Types.ObjectId().toString();
const graph = {
  schemaVersion: 1,
  nodes: [
    { id: "start", type: "trigger", title: "Start", x: 40, y: 80, config: { event: "manual" } },
    { id: "finish", type: "end", title: "Finish", x: 350, y: 80, config: {} },
  ],
  edges: [{ id: "start-finish", source: "start", target: "finish", sourceHandle: "default" }],
};

function request(automationId = "", body: unknown = {}, version = "") {
  return {
    params: { automationId, version }, body,
    organization: { id: ownerId }, user: { id: userId },
  } as unknown as AuthenticatedRequest;
}

function response() {
  const result = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    send() { return this; },
  };
  return result;
}

async function main() {
  let connected = false;
  try {
    await mongoose.connect(env.mongodbUri, { dbName: databaseName, serverSelectionTimeoutMS: 15_000 });
    connected = true;

    const created = response();
    await createAutomation(request("", { name: "Smoke workflow", description: "Safe automation check", graph }), created as unknown as Response);
    assert.equal(created.statusCode, 201);
    const id = String((created.body as { flow: { _id: unknown } }).flow._id);

    const listed = response();
    await listAutomations(request(), listed as unknown as Response);
    assert.equal((listed.body as { flows: unknown[] }).flows.length, 1);

    const loaded = response();
    await getAutomation(request(id), loaded as unknown as Response);
    assert.deepEqual((loaded.body as { flow: { draft: typeof graph } }).flow.draft.nodes[1].config, {});

    const saved = response();
    await saveAutomation(request(id, { name: "Smoke workflow updated", description: "Safe automation check", graph, revision: 1 }), saved as unknown as Response);
    assert.equal((saved.body as { flow: { revision: number } }).flow.revision, 2);

    const checked = response();
    await checkAutomation(request(id, { graph }), checked as unknown as Response);
    assert.deepEqual((checked.body as { issues: unknown[] }).issues, []);

    const tested = response();
    await testAutomation(request(id, { outcome: "qualified" }), tested as unknown as Response);
    assert.deepEqual((tested.body as { steps: Array<{ nodeId: string }> }).steps.map((step) => step.nodeId), ["start", "finish"]);

    const published = response();
    await publishAutomation(request(id), published as unknown as Response);
    assert.equal((published.body as { flow: { status: string; publishedVersion: number } }).flow.status, "live");
    assert.equal((published.body as { flow: { publishedVersion: number } }).flow.publishedVersion, 1);

    const started = response();
    await startAutomationRun(request(id, { phone: "+15555550123", name: "Smoke contact", consentConfirmed: true }), started as unknown as Response);
    assert.equal(started.statusCode, 202);
    const runId = String((started.body as { run: { _id: unknown } }).run._id);
    const eventId = String((started.body as { run: { eventId: string } }).run.eventId);
    const repeated = response();
    await startAutomationRun(request(id, { phone: "+15555550123", name: "Smoke contact", eventId, consentConfirmed: true }), repeated as unknown as Response);
    assert.equal(String((repeated.body as { run: { _id: unknown } }).run._id), runId);
    await assert.rejects(
      startAutomationRun(request(id, { phone: "+15555550124", eventId, consentConfirmed: true }), response() as unknown as Response),
      /already belongs to another contact/,
    );
    let run = await AutomationRunModel.findById(runId);
    for (let attempt = 0; attempt < 30 && run?.status !== "completed"; attempt += 1) {
      await processAutomationRuns();
      await new Promise((resolve) => setTimeout(resolve, 100));
      run = await AutomationRunModel.findById(runId);
    }
    assert.equal(run?.status, "completed", run?.error || "Run did not complete.");
    assert.deepEqual(run.steps.map((step: { nodeId: string }) => step.nodeId), ["start", "finish"]);
    const trace = response();
    await getAutomationRun({ ...request(id), params: { automationId: id, runId } } as AuthenticatedRequest, trace as unknown as Response);
    assert.equal((trace.body as { run: { status: string } }).run.status, "completed");

    const cancelledCandidate = await AutomationRunModel.create({
      ownerId, automationId: id, version: 1, graph, eventId: "cancel-event", contactName: "Cancel contact",
      contactPhone: "+15555550125", currentNodeId: "finish", status: "waiting", waitKind: "delay",
      dueAt: new Date(Date.now() + 60_000), context: { consentConfirmed: true },
    });
    const cancelled = response();
    await cancelAutomationRun({ ...request(id), params: { automationId: id, runId: String(cancelledCandidate._id) } } as AuthenticatedRequest, cancelled as unknown as Response);
    assert.equal((cancelled.body as { run: { status: string } }).run.status, "cancelled");

    const uncertainCandidate = await AutomationRunModel.create({
      ownerId, automationId: id, version: 1, graph, eventId: "uncertain-event", contactName: "Uncertain contact",
      contactPhone: "+15555550126", currentNodeId: "finish", status: "running", actionType: "whatsapp",
      actionNodeId: "finish", leaseUntil: new Date(Date.now() - 60_000), context: { consentConfirmed: true },
    });
    await recoverExpiredAutomationRuns();
    const uncertain = await AutomationRunModel.findById(uncertainCandidate._id);
    assert.equal(uncertain?.status, "failed");
    assert.match(uncertain?.error ?? "", /outcome is uncertain/);

    const runs = response();
    await listAutomationRuns(request(id), runs as unknown as Response);
    assert.equal((runs.body as { runs: unknown[] }).runs.length, 3);

    const paused = response();
    await setAutomationStatus(request(id, { status: "paused" }), paused as unknown as Response);
    assert.equal((paused.body as { flow: { status: string } }).flow.status, "paused");

    const versions = response();
    await listAutomationVersions(request(id), versions as unknown as Response);
    assert.equal((versions.body as { versions: unknown[] }).versions.length, 1);

    const restored = response();
    await restoreAutomationVersion(request(id, {}, "1"), restored as unknown as Response);
    assert.equal((restored.body as { flow: { publishedVersion: number } }).flow.publishedVersion, 2);

    const removed = response();
    await deleteAutomation(request(id), removed as unknown as Response);
    assert.equal(removed.statusCode, 204);
    console.log("Automation smoke passed: create, list, load, save, validate, dry test, publish, idempotent run, cancel, crash recovery, pause, versions, restore, delete.");
  } finally {
    await mongoose.disconnect();
    if (connected && /^vzn_auto_[0-9a-f]{24}$/.test(databaseName)) {
      const cleanup = new mongoose.mongo.MongoClient(env.mongodbUri, { serverSelectionTimeoutMS: 15_000 });
      try {
        await cleanup.connect();
        await cleanup.db(databaseName).dropDatabase();
        console.log("Temporary smoke database removed.");
      } finally {
        await cleanup.close();
      }
    }
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
