import dns from "node:dns";
import mongoose from "mongoose";

import { env } from "../src/config/env.js";
import { AuditLogModel } from "../src/models/AuditLog.js";
import { WhiteLabelBrandModel } from "../src/models/WhiteLabelBrand.js";
import { redactedAuditSnapshot } from "../src/services/auditLogService.js";
import { storeWhiteLabelResendKey } from "../src/services/whiteLabelResendKey.js";

const apply = process.argv.includes("--apply");
let brandKeys = 0;
let auditEntries = 0;

if (env.mongodbUri.startsWith("mongodb+srv://") && env.dnsServers.length > 0) {
  dns.setServers(env.dnsServers);
}
await mongoose.connect(env.mongodbUri, { autoIndex: false });
try {
  const brands = WhiteLabelBrandModel.find({
    "email.resendApiKey": { $exists: true, $nin: ["", null] },
  }).select("email.resendApiKey").lean().cursor();
  for await (const brand of brands) {
    const key = brand.email?.resendApiKey ?? "";
    if (!key || key.startsWith("enc:v1:")) continue;
    brandKeys += 1;
    if (apply) {
      await WhiteLabelBrandModel.updateOne(
        { _id: brand._id, "email.resendApiKey": key },
        { $set: { "email.resendApiKey": storeWhiteLabelResendKey(key) } },
      );
    }
  }

  const audits = AuditLogModel.find({ resource: "white_label_brand" })
    .select("before after")
    .lean()
    .cursor();
  for await (const entry of audits) {
    const before = redactedAuditSnapshot(entry.before);
    const after = redactedAuditSnapshot(entry.after);
    if (JSON.stringify(before) === JSON.stringify(entry.before)
      && JSON.stringify(after) === JSON.stringify(entry.after)) continue;
    auditEntries += 1;
    if (apply) {
      await AuditLogModel.updateOne(
        { _id: entry._id },
        { $set: { before, after } },
      );
    }
  }

  console.log(JSON.stringify({ mode: apply ? "apply" : "dry_run", brandKeys, auditEntries }));
} finally {
  await mongoose.disconnect();
}
