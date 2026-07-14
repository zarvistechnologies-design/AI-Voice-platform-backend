import { app } from "./app.js";
import { connectDatabase } from "./config/database.js";
import { env, validateEnvironment } from "./config/env.js";
import mongoose from "mongoose";
import { processWebhookRetries } from "./services/outboundWebhookService.js";
import { processCampaignQueue } from "./services/campaignService.js";
import { closeDashboardCache } from "./services/dashboardCacheService.js";
import { warmConfiguredModelCatalog } from "./services/modelCatalog.js";

async function bootstrap() {
  validateEnvironment();
  await connectDatabase();

  const server = app.listen(env.port, () => {
    console.log(`Backend running on http://localhost:${env.port}`);
  });
  // Warm read-only provider metadata without delaying readiness. The provider
  // helpers have bounded timeouts and fail open to the built-in catalog.
  void warmConfiguredModelCatalog().catch((error) => {
    console.warn("Dashboard provider catalog warmup failed.", error);
  });
  const retryTimer = setInterval(() => {
    void processWebhookRetries().catch((error) => console.error("Webhook retry worker failed.", error));
  }, 30000);
  retryTimer.unref();
  const campaignTimer = setInterval(() => {
    void processCampaignQueue().catch((error) => console.error("Campaign worker failed.", error));
  }, 5000);
  campaignTimer.unref();
  void processCampaignQueue().catch((error) => console.error("Campaign worker startup failed.", error));

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received. Closing backend gracefully.`);
    clearInterval(retryTimer);
    clearInterval(campaignTimer);
    server.close(async () => {
      await Promise.allSettled([
        mongoose.disconnect(),
        closeDashboardCache(),
      ]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  }

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

void bootstrap().catch(async (error) => {
  console.error("Backend startup failed.", error);
  await Promise.allSettled([
    mongoose.disconnect(),
    closeDashboardCache(),
  ]);
  process.exit(1);
});
