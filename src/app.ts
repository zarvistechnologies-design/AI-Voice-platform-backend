import cors from "cors";
import compression from "compression";
import express from "express";
import mongoose from "mongoose";

import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./routes/authRoutes.js";
import { voiceRouter } from "./routes/voiceRoutes.js";
import { webhookRouter } from "./routes/webhookRoutes.js";
import { organizationRouter } from "./routes/organizationRoutes.js";
import { billingRouter } from "./routes/billingRoutes.js";
import { developerRouter } from "./routes/developerRoutes.js";
import { externalApiRouter } from "./routes/externalApiRoutes.js";
import { integrationRouter } from "./routes/integrationRoutes.js";
import { widgetRouter } from "./routes/widgetRoutes.js";
import { requestContext } from "./middleware/requestContext.js";

export const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(requestContext);
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), geolocation=()");
  response.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  if (env.nodeEnv === "production") {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || env.allowedOrigins.includes(origin)) callback(null, true);
      else callback(new Error("Origin is not allowed by CORS."));
    },
    credentials: true,
  }),
);
app.use(
  compression({
    filter(request, response) {
      const contentType = String(response.getHeader("Content-Type") ?? "").toLowerCase();
      const streamingPath = /\/(?:stream|recording|recording-file)$/.test(request.path);
      const streamingContent =
        contentType.startsWith("text/event-stream") ||
        contentType.startsWith("audio/") ||
        contentType.startsWith("video/") ||
        contentType.startsWith("application/octet-stream");

      return !streamingPath && !streamingContent && compression.filter(request, response);
    },
    threshold: 1024,
  }),
);
app.use("/api/webhooks", webhookRouter);
app.use(express.json({ limit: "1mb" }));
app.use("/api", (_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/", (_request, response) => {
  response.redirect(env.clientUrl);
});

app.get("/health", (request, response) => {
  const database = mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  const status = database === "connected" ? "ok" : "degraded";
  response.status(status === "ok" ? 200 : 503).json({
    status,
    service: "ai-voice-platform-backend",
    requestId: (request as import("./middleware/requestContext.js").RequestWithId).requestId,
    uptimeSeconds: Math.round(process.uptime()),
    checks: {
      database,
      livekitConfigured: Boolean(env.livekitUrl && env.livekitApiKey && env.livekitApiSecret),
      vobizBaseUrl: env.vobizBaseUrl,
      stripeConfigured: Boolean(env.stripeSecretKey && env.stripeWebhookSecret),
      emailConfigured: Boolean(env.resendApiKey),
      knowledgeEmbeddingsConfigured: Boolean(
        env.knowledgeEmbeddingModel &&
        (env.knowledgeEmbeddingProvider === "google" ? env.googleApiKey : env.openaiApiKey),
      ),
    },
  });
});

app.use("/api/widget", widgetRouter);
app.use("/api/auth", authRouter);
app.use("/api/organizations", organizationRouter);
app.use("/api/billing", billingRouter);
app.use("/api/developer", developerRouter);
app.use("/api/v1", externalApiRouter);
app.use("/api/integrations", integrationRouter);
app.use("/api/voice", voiceRouter);

app.use(notFoundHandler);
app.use(errorHandler);
