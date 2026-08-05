import dotenv from "dotenv";

dotenv.config();

function positiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function boundedNumberEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

const configuredKnowledgeEmbeddingProvider = process.env.KNOWLEDGE_EMBEDDING_PROVIDER?.trim().toLowerCase();
const knowledgeEmbeddingProvider = configuredKnowledgeEmbeddingProvider === "openai" || configuredKnowledgeEmbeddingProvider === "google"
  ? configuredKnowledgeEmbeddingProvider
  : (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY ? "google" : "openai");
const renderRuntime = process.env.RENDER === "true";
const nodeEnv = process.env.NODE_ENV ?? (renderRuntime ? "production" : "development");
const hostedRuntime = nodeEnv === "production" || renderRuntime;
const defaultBackendPublicUrl = process.env.RENDER_EXTERNAL_URL?.trim()
  || (hostedRuntime ? "https://www.vozon.ai" : `http://localhost:${process.env.PORT ?? 5000}`);
const defaultDigitalBotApiUrl = hostedRuntime
  ? "https://digital-api-46ss.onrender.com"
  : "http://localhost:4002";
const defaultDigitalBotWebhookBaseUrl = "https://mcp-server-61zc.onrender.com";

function isLoopbackUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

const configuredBackendPublicUrl = process.env.BACKEND_PUBLIC_URL?.trim() || "";
const configuredDigitalBotApiUrl = process.env.DIGITALBOT_API_URL?.trim() || "";
const configuredDigitalBotWebhookBaseUrl = process.env.DIGITALBOT_WEBHOOK_BASE_URL?.trim() || "";
const backendPublicUrl = hostedRuntime && isLoopbackUrl(configuredBackendPublicUrl)
  ? defaultBackendPublicUrl
  : configuredBackendPublicUrl || defaultBackendPublicUrl;
const digitalbotApiUrl = hostedRuntime && isLoopbackUrl(configuredDigitalBotApiUrl)
  ? defaultDigitalBotApiUrl
  : configuredDigitalBotApiUrl || defaultDigitalBotApiUrl;
const digitalbotWebhookBaseUrl = hostedRuntime && isLoopbackUrl(configuredDigitalBotWebhookBaseUrl)
  ? defaultDigitalBotWebhookBaseUrl
  : configuredDigitalBotWebhookBaseUrl || defaultDigitalBotWebhookBaseUrl;

export const env = {
  port: Number(process.env.PORT ?? 5000),
  nodeEnv,
  redisUrl: process.env.REDIS_URL?.trim() ?? "",
  redisKeyPrefix: process.env.REDIS_KEY_PREFIX?.trim() || "ai-voice-platform",
  dashboardCacheTtlSeconds: Math.floor(
    boundedNumberEnv("DASHBOARD_CACHE_TTL_SECONDS", 10, 1, 15),
  ),
  redisCommandTimeoutMs: Math.floor(
    boundedNumberEnv("REDIS_COMMAND_TIMEOUT_MS", 250, 50, 2_000),
  ),
  redisFailureBackoffMs: Math.floor(
    boundedNumberEnv("REDIS_FAILURE_BACKOFF_MS", 5_000, 1_000, 60_000),
  ),
  clientUrl: process.env.CLIENT_URL ?? "http://localhost:3000",
  backendPublicUrl: backendPublicUrl.replace(/\/$/, ""),
  digitalbotApiUrl: digitalbotApiUrl.replace(/\/$/, ""),
  digitalbotWebhookBaseUrl: digitalbotWebhookBaseUrl.replace(/\/$/, ""),
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
  livekitAgentIdleProcesses: nonNegativeIntegerEnv("LIVEKIT_AGENT_IDLE_PROCESSES", 2),
  livekitAgentInitializeTimeoutMs: positiveIntegerEnv("LIVEKIT_AGENT_INITIALIZE_TIMEOUT_MS", 60000),
  livekitAgentShutdownTimeoutMs: positiveIntegerEnv("LIVEKIT_AGENT_SHUTDOWN_TIMEOUT_MS", 60000),
  livekitSipInboundTrunkId: process.env.LIVEKIT_SIP_INBOUND_TRUNK_ID ?? "",
  livekitSipOutboundTrunkId: process.env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID ?? "",
  livekitSipUri: process.env.LIVEKIT_SIP_URI ?? "",
  livekitRecordingPrefix:
    process.env.AWS_RECORDING_S3_PREFIX ??
    process.env.RECORDING_S3_PREFIX ??
    process.env.LIVEKIT_RECORDING_PREFIX ??
    "recordings",
  livekitRecordingPublicBaseUrl:
    process.env.AWS_RECORDING_S3_PUBLIC_BASE_URL ??
    process.env.RECORDING_S3_PUBLIC_BASE_URL ??
    process.env.LIVEKIT_RECORDING_PUBLIC_BASE_URL ??
    "",
  livekitRecordingS3Bucket:
    process.env.AWS_RECORDING_S3_BUCKET ??
    process.env.RECORDING_S3_BUCKET ??
    process.env.LIVEKIT_RECORDING_S3_BUCKET ??
    "",
  livekitRecordingS3Region:
    process.env.AWS_RECORDING_S3_REGION ??
    process.env.RECORDING_S3_REGION ??
    process.env.AWS_REGION ??
    process.env.LIVEKIT_RECORDING_S3_REGION ??
    "",
  livekitRecordingS3Endpoint:
    process.env.AWS_RECORDING_S3_ENDPOINT ??
    process.env.RECORDING_S3_ENDPOINT ??
    process.env.LIVEKIT_RECORDING_S3_ENDPOINT ??
    "",
  livekitRecordingS3AccessKey:
    process.env.AWS_RECORDING_S3_ACCESS_KEY_ID ??
    process.env.RECORDING_S3_ACCESS_KEY_ID ??
    process.env.AWS_ACCESS_KEY_ID ??
    process.env.LIVEKIT_RECORDING_S3_ACCESS_KEY ??
    "",
  livekitRecordingS3Secret:
    process.env.AWS_RECORDING_S3_SECRET_ACCESS_KEY ??
    process.env.RECORDING_S3_SECRET_ACCESS_KEY ??
    process.env.AWS_SECRET_ACCESS_KEY ??
    process.env.LIVEKIT_RECORDING_S3_SECRET ??
    "",
  livekitRecordingS3ForcePathStyle:
    process.env.AWS_RECORDING_S3_FORCE_PATH_STYLE === "true" ||
    process.env.RECORDING_S3_FORCE_PATH_STYLE === "true" ||
    process.env.LIVEKIT_RECORDING_S3_FORCE_PATH_STYLE === "true",
  recordingUrlSigningSecret:
    process.env.RECORDING_URL_SIGNING_SECRET?.trim() ||
    process.env.JWT_SECRET ||
    "development-only-secret-change-me",
  recordingUrlTtlSeconds: Math.floor(
    boundedNumberEnv("RECORDING_URL_TTL_SECONDS", 60 * 24 * 60 * 60, 60, 365 * 24 * 60 * 60),
  ),
  webRecordingStorageDir: process.env.WEB_RECORDING_STORAGE_DIR ?? "recordings",
  vobizBaseUrl: process.env.VOBIZ_BASE_URL ?? "https://api.vobiz.ai/api",
  vobizInboundTrunkId: process.env.VOBIZ_INBOUND_TRUNK_ID ?? "",
  vobizInboundTrunkName: process.env.VOBIZ_INBOUND_TRUNK_NAME?.trim() || "Vozon Inbound",
  vobizOutboundTrunkName: process.env.VOBIZ_OUTBOUND_TRUNK_NAME?.trim() || "Vozon Outbound",
  exotelResolverPath: process.env.EXOTEL_RESOLVER_PATH?.trim() || "/api/exotel/voicebot",
  exotelStreamPath: process.env.EXOTEL_STREAM_PATH?.trim() || "/api/exotel/voicebot/stream",
  exotelPublicBaseUrl: process.env.EXOTEL_PUBLIC_BASE_URL?.trim().replace(/\/$/, "") || "",
  exotelStreamSecret: process.env.EXOTEL_STREAM_SECRET?.trim() || "",
  exotelStreamUsername: process.env.EXOTEL_STREAM_USERNAME?.trim() || "",
  exotelStreamPassword: process.env.EXOTEL_STREAM_PASSWORD ?? "",
  exotelStreamConfigured: Boolean(
    process.env.EXOTEL_STREAM_SECRET?.trim()
      || (process.env.EXOTEL_STREAM_USERNAME?.trim() && process.env.EXOTEL_STREAM_PASSWORD),
  ),
  exotelStreamMaxConnections: Math.floor(
    boundedNumberEnv("EXOTEL_STREAM_MAX_CONNECTIONS", 100, 1, 1_000),
  ),
  telephonyProviderTimeoutMs: Math.floor(
    boundedNumberEnv("TELEPHONY_PROVIDER_TIMEOUT_MS", 12_000, 3_000, 30_000),
  ),
  callFinalizationSettleMs: Math.floor(
    boundedNumberEnv("CALL_FINALIZATION_SETTLE_MS", 10_000, 1_000, 60_000),
  ),
  callRecordingFinalizationWaitMs: Math.floor(
    boundedNumberEnv("CALL_RECORDING_FINALIZATION_WAIT_MS", 10 * 60_000, 30_000, 60 * 60_000),
  ),
  callRuntimeFinalizationWaitMs: Math.floor(
    boundedNumberEnv("CALL_RUNTIME_FINALIZATION_WAIT_MS", 60_000, 10_000, 10 * 60_000),
  ),
  callFinalizationConcurrency: Math.floor(
    boundedNumberEnv("CALL_FINALIZATION_CONCURRENCY", 4, 1, 10),
  ),
  integrationEncryptionKey:
    process.env.INTEGRATION_ENCRYPTION_KEY ?? process.env.JWT_SECRET ?? "development-only-secret-change-me",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiBaseUrl: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
  knowledgeEmbeddingProvider,
  knowledgeEmbeddingModel: process.env.KNOWLEDGE_EMBEDDING_MODEL ?? (knowledgeEmbeddingProvider === "google" ? "gemini-embedding-001" : "text-embedding-3-small"),
  knowledgeEmbeddingDimensions: positiveIntegerEnv("KNOWLEDGE_EMBEDDING_DIMENSIONS", 1536),
  knowledgeEmbeddingBatchSize: positiveIntegerEnv("KNOWLEDGE_EMBEDDING_BATCH_SIZE", 64),
  knowledgeEmbeddingTimeoutMs: positiveIntegerEnv("KNOWLEDGE_EMBEDDING_TIMEOUT_MS", 30000),
  knowledgeVectorIndex: process.env.KNOWLEDGE_VECTOR_INDEX ?? "knowledge_chunks_vector",
  knowledgeTopK: positiveIntegerEnv("KNOWLEDGE_TOP_K", 5),
  knowledgeMinimumScore: boundedNumberEnv("KNOWLEDGE_MINIMUM_SCORE", 0.28, 0, 1),
  knowledgeMaxContextCharacters: positiveIntegerEnv("KNOWLEDGE_MAX_CONTEXT_CHARACTERS", 9000),
  googleApiKey: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleOAuthRedirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI
    ?? `http://localhost:${process.env.PORT ?? 5000}/api/integrations/google/callback`,
  sarvamApiKey: process.env.SARVAM_API_KEY ?? "",
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_API_KEY ?? "",
  deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? "",
  razorpayKeyId: process.env.RAZORPAY_KEY_ID ?? "",
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET ?? "",
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? "",
  razorpayEnterpriseMonthlyUsd: boundedNumberEnv("RAZORPAY_ENTERPRISE_MONTHLY_USD", 500, 1, 10_000),
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  emailUser: process.env.EMAIL_USER?.trim() ?? "",
  emailPass: process.env.EMAIL_PASS?.trim() ?? "",
  emailFrom: process.env.EMAIL_FROM?.trim() || "AI Voice Platform <noreply@example.com>",
  supportInbox: process.env.SUPPORT_INBOX?.trim() || "hello@vozon.ai",
  contactEmail: process.env.CONTACT_EMAIL?.trim() || "hello@vozon.ai",
  requireEmailVerification:
    process.env.REQUIRE_EMAIL_VERIFICATION === "true" || process.env.NODE_ENV === "production",
  enablePostCallAiAnalysis: process.env.ENABLE_POST_CALL_AI_ANALYSIS === "true",
  costRates: {
    telephonyPerMinute: Number(process.env.COST_TELEPHONY_PER_MINUTE ?? 0),
    inrPerUsd: Number(process.env.COST_INR_PER_USD ?? 96.5),
    platformFeeInrPerMinute: Number(process.env.PLATFORM_FEE_INR_PER_MINUTE ?? 1.5),
  },
  billing: {
    initialCredits: Number(process.env.INITIAL_CREDITS ?? 5),
    minimumCallStartCredits: Number(process.env.MINIMUM_CALL_START_CREDITS ?? 0.05),
    markupMultiplier: Number(process.env.BILLING_MARKUP_MULTIPLIER ?? 1),
  },
};

export function validateEnvironment() {
  if (env.nodeEnv !== "production") return;
  const missing = [
    ["MONGODB_URI", env.mongodbUri],
    ["JWT_SECRET", env.jwtSecret],
    ["CLIENT_URL", env.clientUrl],
    ["INTEGRATION_ENCRYPTION_KEY", env.integrationEncryptionKey],
    ["RAZORPAY_KEY_ID", env.razorpayKeyId],
    ["RAZORPAY_KEY_SECRET", env.razorpayKeySecret],
    ["RAZORPAY_WEBHOOK_SECRET", env.razorpayWebhookSecret],
  ].filter(([, value]) => !value || value.includes("development-only"));
  if (missing.length) throw new Error(`Missing production environment values: ${missing.map(([name]) => name).join(", ")}`);
}


