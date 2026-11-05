import dns from "node:dns";
import mongoose from "mongoose";

import { env } from "../config/env.js";
import { UserModel } from "../models/User.js";

const email = process.argv.find((argument) => argument.startsWith("--email="))?.slice(8).trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Usage: npx tsx src/scripts/inspectPlatformAdmin.ts --email=address@example.com");
  process.exitCode = 2;
} else {
  if (env.mongodbUri.startsWith("mongodb+srv://") && env.dnsServers.length) dns.setServers(env.dnsServers);
  try {
    await mongoose.connect(env.mongodbUri, { autoIndex: false, serverSelectionTimeoutMS: 10000 });
    const user = await UserModel.findOne({ email }).select("+passwordHash +platformRole");
    console.log(JSON.stringify({
      exists: Boolean(user),
      emailVerified: Boolean(user?.emailVerified),
      twoFactorEnabled: Boolean(user?.twoFactorEnabled),
      hasPassword: Boolean(user?.passwordHash),
      platformRole: user?.platformRole ?? null,
    }));
  } catch (error) {
    console.error("Account lookup failed:", error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
