import mongoose from "mongoose";

import { connectDatabase } from "../config/database.js";
import { PhoneNumberModel } from "../models/PhoneNumber.js";

const canonicalE164 = /^\+[1-9]\d{7,14}$/;

function maskedNumber(value: string) {
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

async function migratePhoneNumberUniqueness() {
  await connectDatabase({ autoIndex: false });

  const invalidNumbers = await PhoneNumberModel.find({
    number: { $not: canonicalE164 },
  }).select("ownerId number").lean();
  const duplicates = await PhoneNumberModel.aggregate<{
    _id: string;
    count: number;
    owners: string[];
  }>([
    {
      $group: {
        _id: "$number",
        count: { $sum: 1 },
        owners: { $addToSet: "$ownerId" },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  if (invalidNumbers.length || duplicates.length) {
    console.error(JSON.stringify({
      event: "phone-number-uniqueness-audit-failed",
      invalidNumbers: invalidNumbers.map((phone) => ({
        number: maskedNumber(phone.number),
        ownerId: phone.ownerId,
      })),
      duplicates: duplicates.map((duplicate) => ({
        number: maskedNumber(duplicate._id),
        count: duplicate.count,
        owners: duplicate.owners,
      })),
      resolution: "Resolve invalid or duplicate ownership records manually, then rerun this migration.",
    }));
    process.exitCode = 1;
    return;
  }

  const lifecycleBackfill = await PhoneNumberModel.updateMany(
    { lifecycle: { $exists: false } },
    {
      $set: {
        lifecycle: "active",
        mutationToken: "",
        mutationExpiresAt: null,
      },
    },
  );

  const collection = PhoneNumberModel.collection;
  const numberIndex = (await collection.indexes()).find((index) => {
    const keys = Object.entries(index.key);
    return keys.length === 1 && keys[0]?.[0] === "number" && keys[0]?.[1] === 1;
  });

  if (!numberIndex) {
    await collection.createIndex({ number: 1 }, { name: "number_1", unique: true });
  } else if (!numberIndex.unique) {
    if (numberIndex.name !== "number_1") {
      throw new Error(
        `Expected the legacy number index to be named number_1, found ${numberIndex.name}. Review it manually before migration.`,
      );
    }
    const database = mongoose.connection.db;
    if (!database) throw new Error("MongoDB connection is not ready.");
    await database.command({
      collMod: collection.collectionName,
      index: { name: numberIndex.name, prepareUnique: true },
    });
    await database.command({
      collMod: collection.collectionName,
      index: { name: numberIndex.name, unique: true },
      dryRun: true,
    });
    await database.command({
      collMod: collection.collectionName,
      index: { name: numberIndex.name, unique: true },
    });
  }

  const migratedIndex = (await collection.indexes()).find((index) => index.name === "number_1");
  if (!migratedIndex?.unique) {
    throw new Error("The global unique phone-number index was not created.");
  }

  console.log(JSON.stringify({
    event: "phone-number-uniqueness-migration-finished",
    collection: collection.collectionName,
    index: migratedIndex.name,
    unique: migratedIndex.unique,
    lifecycleBackfilled: lifecycleBackfill.modifiedCount,
  }));
}

migratePhoneNumberUniqueness()
  .catch((error) => {
    console.error(JSON.stringify({
      event: "phone-number-uniqueness-migration-failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
