import { VoiceAgentModel } from "../models/VoiceAgent.js";

export async function recordAgentLatency(agentId: string, latencyMs: number) {
  const roundedLatency = Math.round(latencyMs);
  if (!agentId || !Number.isFinite(roundedLatency) || roundedLatency < 0 || roundedLatency > 60000) {
    return;
  }

  const agent = await VoiceAgentModel.findById(agentId).select("latencyMetrics");
  if (!agent) {
    return;
  }

  const current = agent.latencyMetrics;
  const sampleCount = current?.sampleCount ?? 0;
  const previousAverage = current?.averageMs ?? roundedLatency;
  const nextSampleCount = sampleCount + 1;
  const nextAverage = Math.round(
    ((previousAverage * sampleCount) + roundedLatency) / nextSampleCount,
  );

  agent.latencyMetrics = {
    latestMs: roundedLatency,
    averageMs: nextAverage,
    sampleCount: nextSampleCount,
    lastMeasuredAt: new Date(),
  };
  await agent.save();
}
