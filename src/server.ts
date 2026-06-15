import { app } from "./app.js";
import { connectDatabase } from "./config/database.js";
import { env, validateEnvironment } from "./config/env.js";
import mongoose from "mongoose";
import { processWebhookRetries } from "./services/outboundWebhookService.js";

async function bootstrap() {
  validateEnvironment();
  await connectDatabase();

  const server = app.listen(env.port, () => {
    console.log(`Backend running on http://localhost:${env.port}`);
  });
  const retryTimer = setInterval(() => {
    void processWebhookRetries().catch((error) => console.error("Webhook retry worker failed.", error));
  }, 30000);
  retryTimer.unref();

  async function shutdown(signal: string) {
    console.log(`${signal} received. Closing backend gracefully.`);
    clearInterval(retryTimer);
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  }

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

void bootstrap();
