import mongoose from "mongoose";

import { connectDatabase } from "../config/database.js";
import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { CampaignLeadModel } from "../models/CampaignLead.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { WebhookDeliveryModel } from "../models/WebhookDelivery.js";

const models = [
  CallDetailRecordModel,
  CampaignLeadModel,
  PhoneNumberModel,
  WebhookDeliveryModel,
] as const;

await connectDatabase();

try {
  for (const model of models) {
    // createIndexes only adds declared indexes; it does not drop existing ones.
    await model.createIndexes();
    const indexes = await model.collection.indexes();
    console.log(JSON.stringify({
      collection: model.collection.collectionName,
      indexes: indexes.map((index) => index.name),
    }));
  }
} finally {
  await mongoose.disconnect();
}
