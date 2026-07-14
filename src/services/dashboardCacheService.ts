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
const pendingInvalidations = new Map<string, number>();
let lastErrorLogAt = 0;
let globalBypassUntil = 0;
let pendingInvalidationRetryTimer: NodeJS.Timeout | undefined;

function createDashboardRedisClient() {
  if (!env.redisUrl) return null;
  try {
    return createClient({
      url: env.redisUrl,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 256,
      commandOptions: { timeout: env.redisCommandTimeoutMs },
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
  redisClient.on("ready", () => {
    globalBypassUntil = 0;
    void flushPendingInvalidations();
  });
  void redisClient.connect().catch((error) => logCacheError("connect", error));
}

function readyClient() {
  if (globalBypassUntil > Date.now()) return null;
  return redisClient?.isReady ? redisClient : null;
}

function bypassGlobally() {
  globalBypassUntil = Date.now() + env.redisFailureBackoffMs;
}

async function withRedisCommandTimeout<T>(command: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Redis dashboard cache command timed out.")),
      env.redisCommandTimeoutMs,
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

async function bumpGeneration(organizationId: string) {
  if (!redisClient?.isReady) throw new Error("Redis dashboard cache is not ready.");
  const generationTtlSeconds = Math.max(3_600, env.dashboardCacheTtlSeconds * 20);
  await withRedisCommandTimeout(
    redisClient
      .multi()
      .incr(generationKey(organizationId))
      .expire(generationKey(organizationId), generationTtlSeconds)
      .exec(),
  );
}

function schedulePendingInvalidationRetry() {
  if (!redisClient || pendingInvalidationRetryTimer || pendingInvalidations.size === 0) return;
  pendingInvalidationRetryTimer = setTimeout(() => {
    pendingInvalidationRetryTimer = undefined;
    void flushPendingInvalidations();
  }, env.redisFailureBackoffMs);
  pendingInvalidationRetryTimer.unref();
}

async function flushPendingInvalidations() {
  if (!redisClient?.isReady || pendingInvalidations.size === 0) {
    schedulePendingInvalidationRetry();
    return;
  }
  for (const [organizationId, invalidationVersion] of [...pendingInvalidations]) {
    try {
      await bumpGeneration(organizationId);
      if (pendingInvalidations.get(organizationId) === invalidationVersion) {
        pendingInvalidations.delete(organizationId);
        clearLocalBypass(organizationId);
      }
    } catch (error) {
      bypassGlobally();
      logCacheError("invalidate-retry", error);
      schedulePendingInvalidationRetry();
      return;
    }
  }
  schedulePendingInvalidationRetry();
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
  options: { isCacheable?: (value: T) => boolean } = {},
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
      if (
        cached.generation === generation
        && (options.isCacheable?.(cached.value) ?? true)
      ) return cached.value;
    }
  } catch (error) {
    bypassGlobally();
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
      if (activeClient && (options.isCacheable?.(value) ?? true)) {
        try {
          const serialized = JSON.stringify({ generation, value } satisfies CacheEnvelope<T>);
          void withRedisCommandTimeout(
            activeClient.set(tenantDataKey, serialized, { EX: env.dashboardCacheTtlSeconds }),
          )
            .catch((error) => {
              bypassGlobally();
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
  if (!redisClient) {
    bypassLocally(organizationId);
    return;
  }
  const invalidationVersion = (pendingInvalidations.get(organizationId) ?? 0) + 1;
  pendingInvalidations.set(organizationId, invalidationVersion);
  if (!redisClient.isReady) {
    bypassLocally(organizationId);
    schedulePendingInvalidationRetry();
    return;
  }
  try {
    // Invalidation bypasses the read/write circuit breaker so mutations from
    // one replica cannot leave another replica serving an old generation.
    await bumpGeneration(organizationId);
    if (pendingInvalidations.get(organizationId) === invalidationVersion) {
      pendingInvalidations.delete(organizationId);
      clearLocalBypass(organizationId);
    } else {
      schedulePendingInvalidationRetry();
    }
  } catch (error) {
    bypassGlobally();
    bypassLocally(organizationId);
    schedulePendingInvalidationRetry();
    logCacheError("invalidate", error);
  }
}

export const dashboardCacheEnabled = Boolean(redisClient);

export function dashboardCacheStatus() {
  return {
    configured: Boolean(redisClient),
    ready: Boolean(redisClient?.isReady),
    circuitOpen: globalBypassUntil > Date.now(),
    pendingInvalidations: pendingInvalidations.size,
  };
}

export async function closeDashboardCache() {
  if (pendingInvalidationRetryTimer) clearTimeout(pendingInvalidationRetryTimer);
  pendingInvalidationRetryTimer = undefined;
  for (const timer of bypassTimersByOrganization.values()) clearTimeout(timer);
  bypassTimersByOrganization.clear();
  if (!redisClient?.isOpen) return;
  try {
    await redisClient.close();
  } catch (error) {
    logCacheError("close", error);
  }
}
