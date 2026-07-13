import { createClient } from "redis";

import { env } from "../config/env.js";

type CacheEnvelope<T> = {
  generation: string;
  value: T;
};

const keyPrefix = env.redisKeyPrefix.replace(/:+$/g, "");
const cacheNamespace = `${keyPrefix}:dashboard:v1`;
const inFlightLoads = new Map<string, Promise<unknown>>();
const invalidatedInFlightLoads = new Set<string>();
const bypassUntilByOrganization = new Map<string, number>();
const bypassTimersByOrganization = new Map<string, NodeJS.Timeout>();
let lastErrorLogAt = 0;

function createDashboardRedisClient() {
  if (!env.redisUrl) return null;
  try {
    return createClient({
      url: env.redisUrl,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 256,
      commandOptions: { timeout: 1_000 },
      socket: {
        connectTimeout: 2_000,
        reconnectStrategy: (retries) => Math.min(100 * (2 ** Math.min(retries, 5)), 3_000),
      },
    });
  } catch (error) {
    logCacheError("configure", error);
    return null;
  }
}

const redisClient = createDashboardRedisClient();

function logCacheError(operation: string, error: unknown) {
  const now = Date.now();
  if (now - lastErrorLogAt < 60_000) return;
  lastErrorLogAt = now;
  console.warn(JSON.stringify({
    event: "dashboard-cache-unavailable",
    operation,
    error: error instanceof Error ? error.message : String(error),
  }));
}

if (redisClient) {
  redisClient.on("error", (error) => logCacheError("connection", error));
  void redisClient.connect().catch((error) => logCacheError("connect", error));
}

function readyClient() {
  return redisClient?.isReady ? redisClient : null;
}

async function withRedisCommandTimeout<T>(command: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Redis dashboard cache command timed out.")),
      1_000,
    );
    timer.unref();
  });
  try {
    return await Promise.race([command, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function generationKey(organizationId: string) {
  return `${cacheNamespace}:${organizationId}:generation`;
}

function dataKey(organizationId: string, resource: string) {
  return `${cacheNamespace}:${organizationId}:${resource}`;
}

function bypassLocally(organizationId: string) {
  const existingTimer = bypassTimersByOrganization.get(organizationId);
  if (existingTimer) clearTimeout(existingTimer);
  const durationMs = env.dashboardCacheTtlSeconds * 1_000;
  bypassUntilByOrganization.set(
    organizationId,
    Date.now() + durationMs,
  );
  const timer = setTimeout(() => {
    bypassUntilByOrganization.delete(organizationId);
    bypassTimersByOrganization.delete(organizationId);
  }, durationMs);
  timer.unref();
  bypassTimersByOrganization.set(organizationId, timer);
}

function clearLocalBypass(organizationId: string) {
  bypassUntilByOrganization.delete(organizationId);
  const timer = bypassTimersByOrganization.get(organizationId);
  if (timer) clearTimeout(timer);
  bypassTimersByOrganization.delete(organizationId);
}

function localBypassActive(organizationId: string) {
  const bypassUntil = bypassUntilByOrganization.get(organizationId) ?? 0;
  if (bypassUntil > Date.now()) return true;
  if (bypassUntil) clearLocalBypass(organizationId);
  return false;
}

/**
 * Caches only successful JSON-compatible dashboard results. Redis is optional:
 * an absent or unhealthy client always falls through to the original loader.
 *
 * The tenant generation and value are read together. Mutations increment the
 * generation, so an older in-flight read cannot repopulate a valid stale entry.
 */
export async function cachedDashboardRead<T>(
  organizationId: string,
  resource: string,
  loader: () => Promise<T>,
): Promise<T> {
  if (localBypassActive(organizationId)) return loader();
  const client = readyClient();
  if (!client) return loader();

  const tenantGenerationKey = generationKey(organizationId);
  const tenantDataKey = dataKey(organizationId, resource);
  let generation = "0";

  try {
    const [storedGeneration, storedValue] = await withRedisCommandTimeout(
      client.mGet([
        tenantGenerationKey,
        tenantDataKey,
      ]),
    );
    generation = storedGeneration ?? "0";
    if (storedValue) {
      const cached = JSON.parse(storedValue) as CacheEnvelope<T>;
      if (cached.generation === generation) return cached.value;
    }
  } catch (error) {
    bypassLocally(organizationId);
    logCacheError("read", error);
    return loader();
  }

  const inFlightKey = `${tenantDataKey}:${generation}`;
  const existingLoad = inFlightLoads.get(inFlightKey);
  if (existingLoad) return existingLoad as Promise<T>;

  const load = loader()
    .then((value) => {
      const activeClient = invalidatedInFlightLoads.has(inFlightKey)
        || localBypassActive(organizationId)
        ? null
        : readyClient();
      if (activeClient) {
        try {
          const serialized = JSON.stringify({ generation, value } satisfies CacheEnvelope<T>);
          void withRedisCommandTimeout(
            activeClient.set(tenantDataKey, serialized, { EX: env.dashboardCacheTtlSeconds }),
          )
            .catch((error) => {
              bypassLocally(organizationId);
              logCacheError("write", error);
            });
        } catch (error) {
          // Cache serialization must never turn a successful database read into an API error.
          logCacheError("serialize", error);
        }
      }
      return value;
    })
    .finally(() => {
      inFlightLoads.delete(inFlightKey);
      invalidatedInFlightLoads.delete(inFlightKey);
    });

  inFlightLoads.set(inFlightKey, load);
  return load;
}

/**
 * Invalidates all Redis-backed dashboard resources for one organization.
 * Failures never affect the mutation that already succeeded.
 */
export async function invalidateDashboardCache(organizationId: string) {
  const tenantKeyPrefix = dataKey(organizationId, "");
  for (const inFlightKey of inFlightLoads.keys()) {
    if (inFlightKey.startsWith(tenantKeyPrefix)) {
      invalidatedInFlightLoads.add(inFlightKey);
    }
  }
  const client = readyClient();
  if (!client) {
    bypassLocally(organizationId);
    return;
  }
  try {
    await withRedisCommandTimeout(client.incr(generationKey(organizationId)));
    clearLocalBypass(organizationId);
  } catch (error) {
    bypassLocally(organizationId);
    logCacheError("invalidate", error);
  }
}

export const dashboardCacheEnabled = Boolean(redisClient);
