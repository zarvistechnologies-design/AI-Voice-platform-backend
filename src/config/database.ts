import dns from "node:dns";
import mongoose from "mongoose";

import { env } from "./env.js";

let connectionPromise: Promise<typeof mongoose> | null = null;

export async function connectDatabase() {
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

    connectionPromise = mongoose.connect(env.mongodbUri);
    await connectionPromise;
    console.log("MongoDB connected");
  } catch (error) {
    connectionPromise = null;
    console.error("MongoDB connection failed", error);
    process.exit(1);
  }
}
