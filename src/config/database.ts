import dns from "node:dns";
import mongoose from "mongoose";

import { env } from "./env.js";

export async function connectDatabase() {
  try {
    if (env.mongodbUri.startsWith("mongodb+srv://") && env.dnsServers.length > 0) {
      dns.setServers(env.dnsServers);
    }

    await mongoose.connect(env.mongodbUri);
    console.log("MongoDB connected");
  } catch (error) {
    console.error("MongoDB connection failed", error);
    process.exit(1);
  }
}
