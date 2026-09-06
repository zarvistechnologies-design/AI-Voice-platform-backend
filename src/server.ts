import { app } from "./app.js";
import { connectDatabase } from "./config/database.js";
import { env, validateEnvironment } from "./config/env.js";
import mongoose from "mongoose";
import { processWebhookRetries } from "./services/outboundWebhookService.js";
import { processCampaignQueue } from "./services/campaignService.js";
import { processPendingCallFinalizations } from "./services/callRecordService.js";
import { recoverDeferredTerminalCallFinalizations } from "./services/callFinalizationRecoveryService.js";
import { closeDashboardCache } from "./services/dashboardCacheService.js";
import { warmConfiguredModelCatalog } from "./services/modelCatalog.js";
import { processIntegrationRetries } from "./services/integrationService.js";
import { attachExotelVoicebotServer } from "./services/exotelVoicebotService.js";
import { processDueWhiteLabelDomains, processDueWhiteLabelSubscriptions } from "./services/whiteLabelService.js";
import { processWhiteLabelPartnerBilling } from "./services/whiteLabelPartnerBillingService.js";
import { processWhiteLabelCustomerBilling } from "./services/whiteLabelCustomerBillingService.js";

async function bootstrap() {
  validateEnvironment();
  await connectDatabase();

  const server = app.listen(env.port, () => {
    console.log(`Backend running on http://localhost:${env.port}`);
  });
  const exotelVoicebot = attachExotelVoicebotServer(server);
  // Warm read-only provider metadata without delaying readiness. The provider
  // helpers have bounded timeouts and fail open to the built-in catalog.
  void warmConfiguredModelCatalog().catch((error) => {
    console.warn("Dashboard provider catalog warmup failed.", error);
  });
  const retryTimer = setInterval(() => {
    void processWebhookRetries().catch((error) => console.error("Webhook retry worker failed.", error));
  }, 30000);
  retryTimer.unref();
  const integrationRetryTimer = setInterval(() => {
    void processIntegrationRetries().catch((error) => console.error("Integration retry worker failed.", error));
  }, 30000);
  integrationRetryTimer.unref();
  void processIntegrationRetries().catch((error) => console.error("Integration retry worker startup failed.", error));
  const callFinalizationTimer = setInterval(() => {
    void recoverDeferredTerminalCallFinalizations()
      .then(() => processPendingCallFinalizations())
      .catch((error) => {
      console.error("Call finalization retry worker failed.", error);
      });
  }, 30000);
  callFinalizationTimer.unref();
  const campaignTimer = setInterval(() => {
    void processCampaignQueue().catch((error) => console.error("Campaign worker failed.", error));
  }, 5000);
  campaignTimer.unref();
  void processCampaignQueue().catch((error) => console.error("Campaign worker startup failed.", error));
  void recoverDeferredTerminalCallFinalizations()
    .then(() => processPendingCallFinalizations())
    .catch((error) => {
      console.error("Call finalization startup recovery failed.", error);
    });
  const whiteLabelDomainTimer = setInterval(() => {
    void Promise.all([
      processDueWhiteLabelDomains(),
      processDueWhiteLabelSubscriptions(),
      processWhiteLabelPartnerBilling(),
      processWhiteLabelCustomerBilling(),
    ])
      .catch((error) => console.error("White-label lifecycle worker failed.", error));
  }, 60_000);
  whiteLabelDomainTimer.unref();
  void processDueWhiteLabelDomains().catch((error) => console.error("White-label domain startup verification failed.", error));
  void processDueWhiteLabelSubscriptions().catch((error) => console.error("White-label subscription startup check failed.", error));
  void processWhiteLabelPartnerBilling().catch((error) => console.error("White-label partner billing startup check failed.", error));
  void processWhiteLabelCustomerBilling().catch((error) => console.error("White-label customer billing startup check failed.", error));

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received. Closing backend gracefully.`);
    clearInterval(retryTimer);
    clearInterval(integrationRetryTimer);
    clearInterval(callFinalizationTimer);
    clearInterval(campaignTimer);
    clearInterval(whiteLabelDomainTimer);
    await exotelVoicebot.close().catch((error) => {
      console.error("Exotel Voicebot shutdown failed.", error);
    });
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
