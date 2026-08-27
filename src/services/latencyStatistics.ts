export const latencySampleWindowSize = 100;

export type LatencyPercentiles = {
  minMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
};

export function boundedLatencySamples(samples: number[], nextSample: number) {
  const valid = [...samples, Math.round(nextSample)].filter(
    (value) => Number.isFinite(value) && value >= 0 && value <= 60_000,
  );
  return valid.slice(-latencySampleWindowSize);
}

function nearestRank(sorted: number[], percentile: number) {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index] ?? 0;
}

export function latencyPercentiles(samples: number[]): LatencyPercentiles {
  const sorted = samples
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 60_000)
    .map(Math.round)
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { minMs: 0, p50Ms: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  return {
    minMs: sorted[0],
    p50Ms: nearestRank(sorted, 0.5),
    p90Ms: nearestRank(sorted, 0.9),
    p95Ms: nearestRank(sorted, 0.95),
    p99Ms: nearestRank(sorted, 0.99),
    maxMs: sorted[sorted.length - 1],
  };
}
