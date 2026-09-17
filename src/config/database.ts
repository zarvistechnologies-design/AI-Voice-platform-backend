import dns from "node:dns";
import mongoose from "mongoose";

import { env } from "./env.js";

let connectionPromise: Promise<typeof mongoose> | null = null;

const LEGACY_INDEXES: ReadonlyArray<readonly [collection: string, indexName: string]> = [
  ["billinginvoices", "stripeInvoiceId_1"],
  ["billingtransactions", "stripeSessionId_1"],
  ["billingsubscriptions", "stripeCustomerId_1"],
  ["billingsubscriptions", "stripeSubscriptionId_1"],
  ["creditwallets", "stripeCustomerId_1"],
];

async function dropLegacyIndexes(db: mongoose.mongo.Db) {
  for (const [collectionName, indexName] of LEGACY_INDEXES) {
    try {
      const exists = await db.listCollections({ name: collectionName }).hasNext();
      if (!exists) continue;
      const indexes = await db.collection(collectionName).indexes();
      if (indexes.some((index) => index.name === indexName)) {
        await db.collection(collectionName).dropIndex(indexName);
        console.log(`Dropped obsolete legacy index ${collectionName}.${indexName}`);
      }
    } catch {
      // Ignored: index may have already been dropped or lack permissions
    }
  }
}

export async function connectDatabase(options: { autoIndex?: boolean } = {}) {
  try {
    if (mongoose.connection.readyState === 1) {
      return;
    }
    if (connectionPromise) {
      await connectionPromise;
      return;
    }

    if (env.mongodbUri.startsWith("mongodb+srv://") && env.dnsServers.length > 0) {
      dns.setServers(env.dnsServers);
    }

    connectionPromise = mongoose.connect(env.mongodbUri, {
      // Production indexes are migrated explicitly before traffic is shifted.
      // This avoids every replica attempting index DDL during startup.
      autoIndex: options.autoIndex ?? env.nodeEnv !== "production",
    });
    await connectionPromise;
    if (mongoose.connection.db) {
      await dropLegacyIndexes(mongoose.connection.db);
    }
    console.log("MongoDB connected");
  } catch (error) {
    connectionPromise = null;
    console.error("MongoDB connection failed", error);
    throw error;
  }
}
