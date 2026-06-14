import dotenv from "dotenv";

dotenv.config();

export const env = {
  port: Number(process.env.PORT ?? 5000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  clientUrl: process.env.CLIENT_URL ?? "http://localhost:3000",
  mongodbUri:
    process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/ai-voice-platform",
  dnsServers:
    process.env.DNS_SERVERS?.split(",")
      .map((server) => server.trim())
      .filter(Boolean) ?? [],
  jwtSecret: process.env.JWT_SECRET ?? "development-only-secret-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  livekitUrl: process.env.LIVEKIT_URL ?? "",
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? "",
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? "",
  livekitAgentName:
    process.env.LIVEKIT_AGENT_NAME ?? process.env.AGENT_NAME ?? "voice-platform-agent",
  livekitSipInboundTrunkId: process.env.LIVEKIT_SIP_INBOUND_TRUNK_ID ?? "",
  livekitSipOutboundTrunkId: process.env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID ?? "",
  vobizBaseUrl: process.env.VOBIZ_BASE_URL ?? "https://api.vobiz.ai/api",
  integrationEncryptionKey:
    process.env.INTEGRATION_ENCRYPTION_KEY ?? process.env.JWT_SECRET ?? "development-only-secret-change-me",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  googleApiKey: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "",
  sarvamApiKey: process.env.SARVAM_API_KEY ?? "",
};
