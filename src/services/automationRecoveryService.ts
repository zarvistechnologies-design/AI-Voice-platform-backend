import { AutomationRunModel } from "../models/Automation.js";

export async function recoverExpiredAutomationRuns(now = new Date()) {
  const expired = { status: "running", leaseUntil: { $lt: now } };
  await AutomationRunModel.updateMany(
    { ...expired, actionType: "call", callId: { $nin: ["", null] } },
    { $set: { status: "waiting", waitKind: "call", dueAt: now, leaseUntil: null, actionType: "", actionNodeId: "" }, $inc: { __v: 1 } },
  );
  await AutomationRunModel.updateMany(
    { ...expired, actionType: "whatsapp", whatsappMessageId: { $nin: ["", null] } },
    { $set: { status: "waiting", waitKind: "whatsapp_delivery", dueAt: now, leaseUntil: null, actionType: "", actionNodeId: "" }, $inc: { __v: 1 } },
  );
  // An external provider may have accepted an action before the process stopped.
  await AutomationRunModel.updateMany(
    { ...expired, actionType: { $in: ["call", "whatsapp", "payment", "calendar", "crm", "notification"] } },
    { $set: { status: "failed", error: "Action outcome is uncertain after a worker interruption. Check the provider before starting another run.", finishedAt: now, leaseUntil: null }, $inc: { __v: 1 } },
  );
  await AutomationRunModel.updateMany(
    { ...expired, actionType: { $in: ["", null] } },
    { $set: { status: "queued", dueAt: now, leaseUntil: null }, $inc: { __v: 1 } },
  );
}
