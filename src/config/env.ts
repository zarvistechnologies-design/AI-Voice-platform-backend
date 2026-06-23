import dotenv from "dotenv";

dotenv.config();

function positiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export const env = {
  port: Number(process.env.PORT ?? 5000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  clientUrl: process.env.CLIENT_URL ?? "http://localhost:3000",
  allowedOrigins:
    process.env.ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean) ??
    [process.env.CLIENT_URL ?? "http://localhost:3000"],
  mongodbUri:
    process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/ai-voice-platform",
  dnsServers:
    process.env.DNS_SERVERS?.split(",")
      .map((server: string) => server.trim())
      .filter(Boolean) ?? [],
  jwtSecret: process.env.JWT_SECRET ?? "development-only-secret-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  authCookieName: process.env.AUTH_COOKIE_NAME ?? "ai_voice_session",
  authRefreshCookieName: process.env.AUTH_REFRESH_COOKIE_NAME ?? "ai_voice_refresh",
  livekitUrl: process.env.LIVEKIT_URL ?? "",
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? "",
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? "",
  livekitAgentName:
    process.env.LIVEKIT_AGENT_NAME ?? process.env.AGENT_NAME ?? "voice-platform-agent",
  livekitAgentIdleProcesses: positiveIntegerEnv("LIVEKIT_AGENT_IDLE_PROCESSES", 1),
  livekitAgentInitializeTimeoutMs: positiveIntegerEnv("LIVEKIT_AGENT_INITIALIZE_TIMEOUT_MS", 60000),
  livekitAgentShutdownTimeoutMs: positiveIntegerEnv("LIVEKIT_AGENT_SHUTDOWN_TIMEOUT_MS", 60000),
  livekitSipInboundTrunkId: process.env.LIVEKIT_SIP_INBOUND_TRUNK_ID ?? "",
  livekitSipOutboundTrunkId: process.env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID ?? "",
  livekitSipUri: process.env.LIVEKIT_SIP_URI ?? "",
  vobizBaseUrl: process.env.VOBIZ_BASE_URL ?? "https://api.vobiz.ai/api",
  vobizInboundTrunkId: process.env.VOBIZ_INBOUND_TRUNK_ID ?? "",
  integrationEncryptionKey:
    process.env.INTEGRATION_ENCRYPTION_KEY ?? process.env.JWT_SECRET ?? "development-only-secret-change-me",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  googleApiKey: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  sarvamApiKey: process.env.SARVAM_API_KEY ?? "",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "AI Voice Platform <noreply@example.com>",
  requireEmailVerification:
    process.env.REQUIRE_EMAIL_VERIFICATION === "true" || process.env.NODE_ENV === "production",
  enablePostCallAiAnalysis: process.env.ENABLE_POST_CALL_AI_ANALYSIS === "true",
  costRates: {
    llmPerMillionTokens: Number(process.env.COST_LLM_PER_MILLION_TOKENS ?? 1),
    sttPerMinute: Number(process.env.COST_STT_PER_MINUTE ?? 0.006),
    ttsPerMillionCharacters: Number(process.env.COST_TTS_PER_MILLION_CHARACTERS ?? 15),
    telephonyPerMinute: Number(process.env.COST_TELEPHONY_PER_MINUTE ?? 0.01),
  },
  billing: {
    initialCredits: Number(process.env.INITIAL_CREDITS ?? 1000),
    minimumCallStartCredits: Number(process.env.MINIMUM_CALL_START_CREDITS ?? 0.05),
    markupMultiplier: Number(process.env.BILLING_MARKUP_MULTIPLIER ?? 2.5),
  },
};

export function validateEnvironment() {
  if (env.nodeEnv !== "production") return;
  const missing = [
    ["MONGODB_URI", env.mongodbUri],
    ["JWT_SECRET", env.jwtSecret],
    ["CLIENT_URL", env.clientUrl],
    ["INTEGRATION_ENCRYPTION_KEY", env.integrationEncryptionKey],
  ].filter(([, value]) => !value || value.includes("development-only"));
  if (missing.length) throw new Error(`Missing production environment values: ${missing.map(([name]) => name).join(", ")}`);
}
