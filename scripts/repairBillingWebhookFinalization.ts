import mongoose from "mongoose";

import { connectDatabase } from "../src/config/database.js";
import { BillingTransactionModel } from "../src/models/BillingTransaction.js";
import { CallDetailRecordModel } from "../src/models/CallDetailRecord.js";
import { WebhookDeliveryModel } from "../src/models/WebhookDelivery.js";
import { finalizeTerminalCall } from "../src/services/callRecordService.js";
import { processWebhookRetries } from "../src/services/outboundWebhookService.js";

const indexName = "razorpayOrderId_1";

await connectDatabase({ autoIndex: false });

try {
  const indexes = await BillingTransactionModel.collection.indexes();
  const existing = indexes.find((index) => index.name === indexName);
  if (existing) {
    const keys = Object.entries(existing.key);
    const expectedKey = keys.length === 1 && keys[0]?.[0] === "razorpayOrderId" && keys[0]?.[1] === 1;
    if (!expectedKey) {
      throw new Error(`Refusing to replace unexpected index ${indexName}: ${JSON.stringify(existing.key)}`);
    }
    if (existing.unique === true) {
      await BillingTransactionModel.collection.dropIndex(indexName);
      await BillingTransactionModel.collection.createIndex(
        { razorpayOrderId: 1 },
        { name: indexName },
      );
      console.log(JSON.stringify({ event: "billing-index-repaired", indexName }));
    } else {
      console.log(JSON.stringify({ event: "billing-index-already-correct", indexName }));
    }
  } else {
    await BillingTransactionModel.collection.createIndex(
      { razorpayOrderId: 1 },
      { name: indexName },
    );
    console.log(JSON.stringify({ event: "billing-index-created", indexName }));
  }

  const candidates = await CallDetailRecordModel.find({
    status: { $in: ["completed", "failed", "cancelled"] },
    terminalFinalizationStatus: { $in: ["pending", "failed"] },
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .select("livekitRoomName")
    .lean();

  const results = await Promise.allSettled(
    candidates.map((call) => finalizeTerminalCall(call.livekitRoomName)),
  );
  const rejected = results.filter((result) => result.status === "rejected");
  await processWebhookRetries();
  const deliveries = await WebhookDeliveryModel.find()
    .sort({ createdAt: -1 })
    .limit(20)
    .select("event status attempts responseStatus errorMessage deliveredAt")
    .lean();

  console.log(JSON.stringify({
    event: "terminal-finalization-repair-completed",
    inspected: candidates.length,
    succeeded: results.length - rejected.length,
    failed: rejected.length,
    errors: rejected.map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason)),
    deliveries,
  }, null, 2));
} finally {
  await mongoose.disconnect();
}
