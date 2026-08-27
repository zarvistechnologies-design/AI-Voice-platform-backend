import { VoiceAgentModel } from "../models/VoiceAgent.js";
import { boundedLatencySamples, latencyPercentiles } from "./latencyStatistics.js";

export type VoiceLatencyStage = "end_of_utterance" | "llm" | "tts" | "realtime_model";

const stageSamples = new Map<string, number[]>();
const maxTrackedStageSeries = 500;

export function recordAgentLatencyStage(
  agentId: string,
  stage: VoiceLatencyStage,
  latencyMs: number,
) {
  if (!agentId || !Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 60_000) {
    return undefined;
  }
  const key = `${agentId}:${stage}`;
  if (!stageSamples.has(key) && stageSamples.size >= maxTrackedStageSeries) {
    const oldestKey = stageSamples.keys().next().value as string | undefined;
    if (oldestKey) stageSamples.delete(oldestKey);
  }
  const samples = boundedLatencySamples(stageSamples.get(key) ?? [], latencyMs);
  // Refresh insertion order so the cap behaves like a small LRU cache.
  stageSamples.delete(key);
  stageSamples.set(key, samples);
  return { sampleCount: samples.length, ...latencyPercentiles(samples) };
}

export async function recordAgentLatency(agentId: string, latencyMs: number) {
  const roundedLatency = Math.round(latencyMs);
  if (!agentId || !Number.isFinite(roundedLatency) || roundedLatency < 0 || roundedLatency > 60000) {
    return;
  }

  const agent = await VoiceAgentModel.findById(agentId).select(
    "latencyMetrics +latencyMetrics.recentSamplesMs",
  );
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
  const recentSamplesMs = boundedLatencySamples(
    Array.isArray(current?.recentSamplesMs) ? current.recentSamplesMs : [],
    roundedLatency,
  );
  const percentiles = latencyPercentiles(recentSamplesMs);

  agent.latencyMetrics = {
    latestMs: roundedLatency,
    averageMs: nextAverage,
    sampleCount: nextSampleCount,
    recentSamplesMs,
    ...percentiles,
    lastMeasuredAt: new Date(),
  };
  await agent.save();
}
