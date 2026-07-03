import dotenv from "dotenv";

dotenv.config();

function positiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function boundedNumberEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

const configuredKnowledgeEmbeddingProvider = process.env.KNOWLEDGE_EMBEDDING_PROVIDER?.trim().toLowerCase();
const knowledgeEmbeddingProvider = configuredKnowledgeEmbeddingProvider === "openai" || configuredKnowledgeEmbeddingProvider === "google"
  ? configuredKnowledgeEmbeddingProvider
  : (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY ? "google" : "openai");

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
  livekitAgentIdleProcesses: positiveIntegerEnv("LIVEKIT_AGENT_IDLE_PROCESSES", 2),
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
  webRecordingStorageDir: process.env.WEB_RECORDING_STORAGE_DIR ?? "recordings",
  vobizBaseUrl: process.env.VOBIZ_BASE_URL ?? "https://api.vobiz.ai/api",
  vobizInboundTrunkId: process.env.VOBIZ_INBOUND_TRUNK_ID ?? "",
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
  sarvamApiKey: process.env.SARVAM_API_KEY ?? "",
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_API_KEY ?? "",
  deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? "",
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
    inrPerUsd: Number(process.env.COST_INR_PER_USD ?? 83),
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
