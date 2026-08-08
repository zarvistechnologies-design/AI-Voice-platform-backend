import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

export type VobizNumber = {
  id: string;
  e164: string;
  country: string;
  region?: string;
  status: string;
  setup_fee?: number;
  monthly_fee?: number;
  currency?: string;
  capabilities?: {
    voice?: boolean;
    sms?: boolean;
    mms?: boolean;
    fax?: boolean;
  };
  voice_enabled?: boolean;
  trunk_group_id?: string;
};

export type VobizCredentials = {
  authId: string;
  authToken: string;
};

type VobizListResponse = {
  items: VobizNumber[];
  page: number;
  per_page: number;
  total: number;
};

type VobizPurchaseResponse = {
  message?: string;
  number?: VobizNumber;
  items?: VobizNumber[];
};

export type VobizTrunk = {
  trunk_id: string;
  account_id: string;
  name: string;
  trunk_domain: string;
  trunk_status: string;
  trunk_direction: "inbound" | "outbound" | "both";
  concurrent_calls_limit: number;
  cps_limit: number;
  primary_uri_uuid?: string;
  inbound_destination?: string;
  updated_at?: string;
};

type VobizTrunkListResponse = {
  meta: { limit: number; offset: number; total: number };
  objects: VobizTrunk[];
};

type VobizOriginationUri = {
  id: string;
  uri: string;
  description?: string;
  enabled: boolean;
  transport: string;
  priority: number;
  weight: number;
};

export type VobizLiveKitInboundRoute = {
  trunkId: string;
  trunkName: string;
  livekitSipUri: string;
  inboundDestination: string;
  assigned: boolean;
  reassigned: boolean;
};

type VobizResponseBody<T> = T & {
  message?: unknown;
  error?: unknown;
  requestId?: unknown;
};

function requireVobiz(credentials: VobizCredentials) {
  if (!credentials.authId || !credentials.authToken) {
    throw new HttpError(
      400,
      "Enter a Vobiz Auth ID and Auth Token.",
    );
  }
}

async function vobizRequest<T>(
  credentials: VobizCredentials,
  path: string,
  init: RequestInit = {},
) {
  requireVobiz(credentials);
  const signal = init.signal ?? AbortSignal.timeout(env.telephonyProviderTimeoutMs);
  const method = (init.method ?? "GET").toUpperCase();
  try {
    const response = await fetch(
      `${env.vobizBaseUrl.replace(/\/$/, "")}/v1/Account/${encodeURIComponent(credentials.authId)}${path}`,
      {
        ...init,
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Auth-ID": credentials.authId,
          "X-Auth-Token": credentials.authToken,
          ...init.headers,
        },
      },
    );
    let body: VobizResponseBody<T> | null = null;
    try {
      body = await response.json() as VobizResponseBody<T>;
    } catch (error) {
      if (signal.aborted) throw error;
    }

    if (!response.ok) {
      const nestedError = body?.error && typeof body.error === "object"
        ? body.error as { message?: unknown; code?: unknown }
        : null;
      const providerMessage = [body?.message, typeof body?.error === "string" ? body.error : nestedError?.message]
        .find((value): value is string => typeof value === "string" && Boolean(value.trim()))
        ?.trim()
        .slice(0, 500);

      // A telephony provider rejecting its credentials must never look like an
      // expired application login to the frontend.
      if (response.status === 401 || response.status === 403) {
        throw new HttpError(400, "Vobiz rejected the Auth ID or Auth Token. Check the credentials and try again.");
      }
      throw new HttpError(
        response.status,
        providerMessage ?? `Vobiz request failed with status ${response.status}.`,
      );
    }
    if (response.status === 204) return {} as T;
    if (!body) {
      throw new HttpError(502, "Vobiz returned an empty response.");
    }
    return body;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
      throw new HttpError(
        504,
        method === "GET"
          ? "Vobiz verification timed out. Please try again."
          : "Vobiz did not confirm the update before timeout. Sync the provider state before retrying.",
      );
    }
    throw new HttpError(
      502,
      method === "GET"
        ? "Vobiz could not be reached. Please try again."
        : "Vobiz did not confirm the update because the provider could not be reached. Sync the provider state before retrying.",
    );
  }
}

function normalizeSipDestination(value: string) {
  return value.trim().replace(/^sip:/i, "").replace(/\/$/, "");
}

function vobizInboundDestination(value: string) {
  const destination = normalizeSipDestination(value).replace(/[;?].*$/, "");
  return destination.replace(/:506[01]$/, "");
}

function vobizOriginationUri(value: string) {
  const destination = vobizInboundDestination(value);
  if (!destination) return "";
  return `${destination}:5060`;
}

function livekitSipHost(value: string) {
  const destination = vobizInboundDestination(value);
  const at = destination.lastIndexOf("@");
  return at >= 0 ? destination.slice(at + 1) : destination;
}

function livekitSipUri() {
  const explicit = env.livekitSipUri.trim();
  if (explicit) return explicit;

  try {
    const hostname = new URL(env.livekitUrl).hostname;
    if (hostname.endsWith(".livekit.cloud") && !hostname.endsWith(".sip.livekit.cloud")) {
      return `sip:${hostname.replace(/\.livekit\.cloud$/i, ".sip.livekit.cloud")}`;
    }
  } catch {
    return "";
  }
  return "";
}

function comparableSipDestination(value = "") {
  return normalizeSipDestination(value).replace(/[;?].*$/, "").replace(/:506[01]$/, "");
}

function sameSipDestination(left: string, right: string) {
  return comparableSipDestination(left).toLowerCase() === comparableSipDestination(right).toLowerCase();
}

function isLiveKitSipDestination(value = "") {
  return /\.sip\.livekit\.cloud$/i.test(comparableSipDestination(value));
}

function isInboundCapable(trunk: VobizTrunk) {
  return ["inbound", "both"].includes(trunk.trunk_direction) && trunk.trunk_status === "active";
}

function isOutboundCapable(trunk: VobizTrunk) {
  return ["outbound", "both"].includes(trunk.trunk_direction) &&
    trunk.trunk_status === "active" &&
    Boolean(trunk.trunk_domain.trim());
}

function vozonTrunkName(direction: VobizTrunk["trunk_direction"]) {
  if (direction === "inbound") return env.vobizInboundTrunkName;
  if (direction === "outbound") return env.vobizOutboundTrunkName;
  return `${env.vobizInboundTrunkName} & ${env.vobizOutboundTrunkName}`;
}

async function renameLegacyLiveKitTrunks(
  credentials: VobizCredentials,
  trunks: VobizTrunk[],
  selectedInboundTrunkId: string,
) {
  const legacyTrunks = trunks.filter(
    (trunk) =>
      trunk.trunk_id !== selectedInboundTrunkId
      && /live\s*kit/i.test(trunk.name)
      && trunk.name !== vozonTrunkName(trunk.trunk_direction),
  );
  await Promise.all(
    legacyTrunks.map((trunk) =>
      vobizRequest<VobizTrunk>(
        credentials,
        `/trunks/${encodeURIComponent(trunk.trunk_id)}`,
        {
          method: "PUT",
          body: JSON.stringify({ name: vozonTrunkName(trunk.trunk_direction) }),
        },
      ),
    ),
  );
}

function selectInboundTrunk(trunks: VobizTrunk[], destination: string) {
  const inbound = trunks.filter(isInboundCapable);
  if (env.vobizInboundTrunkId) {
    const configured = inbound.find((trunk) => trunk.trunk_id === env.vobizInboundTrunkId);
    if (configured) return configured;
    throw new HttpError(409, "VOBIZ_INBOUND_TRUNK_ID is not an active inbound Vobiz trunk.");
  }
  if (destination) {
    const matchingDestination = inbound.find(
      (trunk) => sameSipDestination(trunk.inbound_destination ?? "", destination),
    );
    if (matchingDestination) return matchingDestination;
  }
  return (
    inbound.find((trunk) => /livekit/i.test(trunk.name)) ??
    inbound.find((trunk) => isLiveKitSipDestination(trunk.inbound_destination)) ??
    inbound[0]
  );
}

export function livekitProviderSipUri() {
  const host = livekitSipHost(livekitSipUri());
  if (!host) {
    throw new HttpError(
      409,
      "Set LIVEKIT_SIP_URI to your LiveKit SIP endpoint, for example your-project.sip.livekit.cloud:5060.",
    );
  }
  return `sip:${host}`;
}

export function livekitUserSipUri(_phoneNumber: string) {
  return livekitProviderSipUri();
}

async function upsertVobizOriginationUri(
  credentials: VobizCredentials,
  trunk: VobizTrunk,
  uri: string,
) {
  const payload = {
    uri,
    priority: 1,
    weight: 10,
    enabled: true,
    transport: "udp",
    description: "Vozon inbound SIP",
  };

  if (trunk.primary_uri_uuid) {
    const path = `/trunks/${encodeURIComponent(trunk.trunk_id)}/origination-uris/${encodeURIComponent(trunk.primary_uri_uuid)}`;
    try {
      const existing = await vobizRequest<VobizOriginationUri>(credentials, path);
      const alreadyConfigured =
        existing.uri.trim().toLowerCase() === uri.trim().toLowerCase() &&
        existing.description?.trim() === payload.description &&
        existing.enabled &&
        existing.transport.toLowerCase() === payload.transport &&
        existing.priority === payload.priority &&
        existing.weight === payload.weight;
      if (alreadyConfigured) return { uri: existing, changed: false };

      const updated = await vobizRequest<VobizOriginationUri>(credentials, path, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      return { uri: updated, changed: true };
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
    }
  }

  const created = await vobizRequest<VobizOriginationUri>(
    credentials,
    `/trunks/${encodeURIComponent(trunk.trunk_id)}/origination-uris`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
  return { uri: created, changed: true };
}

export async function listVobizOwnedNumbers(
  credentials: VobizCredentials,
  page = 1,
  perPage = 100,
  signal?: AbortSignal,
) {
  return vobizRequest<VobizListResponse>(
    credentials,
    `/numbers?page=${Math.max(1, page)}&per_page=${Math.min(100, Math.max(1, perPage))}`,
    { signal },
  );
}

export async function listVobizInventory(
  credentials: VobizCredentials,
  input: {
    country?: string;
    search?: string;
    page?: number;
    perPage?: number;
  },
) {
  const query = new URLSearchParams({
    page: String(Math.max(1, input.page ?? 1)),
    per_page: String(Math.min(100, Math.max(1, input.perPage ?? 25))),
  });
  if (input.country) query.set("country", input.country.toUpperCase());
  if (input.search) query.set("search", input.search);
  return vobizRequest<VobizListResponse>(
    credentials,
    `/inventory/numbers?${query.toString()}`,
  );
}

export async function findVobizOwnedNumberWithAccount(credentials: VobizCredentials, e164: string) {
  const signal = AbortSignal.timeout(env.telephonyProviderTimeoutMs);
  for (let page = 1; ; page += 1) {
    const response = await listVobizOwnedNumbers(credentials, page, 100, signal);
    const number = response.items.find((item) => item.e164 === e164);
    if (number) return { number, total: response.total };
    if (!response.items.length || response.per_page <= 0 || page * response.per_page >= response.total) break;
  }

  throw new HttpError(
    404,
    "Vobiz did not return this number as an active owned number. Trial numbers cannot be used for inbound routing; complete Vobiz verification or purchase a full inbound DID, then sync phone numbers.",
  );
}

export async function findVobizOwnedNumber(credentials: VobizCredentials, e164: string) {
  return (await findVobizOwnedNumberWithAccount(credentials, e164)).number;
}

export async function purchaseVobizNumber(
  credentials: VobizCredentials,
  e164: string,
  currency?: string,
  idempotencyKey?: string,
) {
  let originalError: unknown;
  try {
    const response = await vobizRequest<VobizPurchaseResponse>(
      credentials,
      "/numbers/purchase-from-inventory",
      {
        method: "POST",
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
        body: JSON.stringify({ e164, ...(currency ? { currency } : {}) }),
      },
    );
    const number = response.number ?? response.items?.find((item) => item.e164 === e164);
    if (number?.e164 === e164) return number;
    originalError = new HttpError(502, "Vobiz accepted the purchase but did not return the requested number details.");
  } catch (error) {
    originalError = error;
    if (
      !(error instanceof HttpError)
      || ![404, 409, 500, 502, 503, 504].includes(error.statusCode)
    ) {
      throw error;
    }
  }

  // A timed-out POST may already have charged the account. Reconcile with the
  // owned-number list instead of issuing a second purchase request.
  try {
    return await findVobizOwnedNumber(credentials, e164);
  } catch (reconciliationError) {
    if (
      originalError instanceof HttpError
      && [404, 409].includes(originalError.statusCode)
      && reconciliationError instanceof HttpError
      && reconciliationError.statusCode === 404
    ) {
      throw originalError;
    }
    throw new VobizPurchaseUnconfirmedError();
  }
}

export class VobizPurchaseUnconfirmedError extends HttpError {
  constructor() {
    super(
      504,
      "Vobiz purchase status could not be confirmed. Do not purchase the number again yet; refresh or sync owned numbers first.",
    );
  }
}

export async function listVobizTrunks(credentials: VobizCredentials) {
  return vobizRequest<VobizTrunkListResponse>(credentials, "/trunks?limit=100&offset=0");
}

export function selectVobizOutboundTrunk(trunks: VobizTrunk[]) {
  const outbound = trunks.filter(isOutboundCapable);
  if (!outbound.length) {
    throw new HttpError(409, "Vobiz does not have an active outbound SIP trunk with a trunk domain.");
  }
  return (
    outbound.find((trunk) => trunk.name === env.vobizOutboundTrunkName) ??
    outbound.find((trunk) => trunk.trunk_direction === "outbound") ??
    outbound[0]
  );
}

export async function updateVobizTrunkInboundDestination(
  credentials: VobizCredentials,
  trunk: VobizTrunk,
  inboundDestination: string,
) {
  const destination = vobizInboundDestination(inboundDestination);
  const originationUri = vobizOriginationUri(inboundDestination);
  const { uri, changed: uriChanged } = await upsertVobizOriginationUri(
    credentials,
    trunk,
    originationUri,
  );

  let updatedTrunk = trunk;
  const brandedName = vozonTrunkName(trunk.trunk_direction);
  if (
    trunk.name !== brandedName
    || trunk.trunk_status !== "active"
    || trunk.primary_uri_uuid !== uri.id
  ) {
    updatedTrunk = await vobizRequest<VobizTrunk>(
      credentials,
      `/trunks/${encodeURIComponent(trunk.trunk_id)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          name: brandedName,
          max_concurrent_calls: trunk.concurrent_calls_limit,
          enabled: trunk.trunk_status !== "inactive",
          primary_uri_uuid: uri.id,
        }),
      },
    );
  }

  if (
    uriChanged ||
    !sameSipDestination(updatedTrunk.inbound_destination ?? "", destination)
  ) {
    updatedTrunk = await vobizRequest<VobizTrunk>(
      credentials,
      `/trunks/${encodeURIComponent(trunk.trunk_id)}`,
      {
        method: "PUT",
        body: JSON.stringify({ inbound_destination: destination }),
      },
    );
  }

  return updatedTrunk;
}

export async function assignVobizNumberToTrunk(
  credentials: VobizCredentials,
  phoneNumber: string,
  trunkId: string,
) {
  const current = await findVobizOwnedNumber(credentials, phoneNumber);
  if (current.trunk_group_id === trunkId) {
    return { assigned: true, reassigned: false };
  }

  const path = `/numbers/${encodeURIComponent(phoneNumber)}/assign`;
  try {
    await vobizRequest<Record<string, never>>(credentials, path, {
      method: "POST",
      body: JSON.stringify({ trunk_group_id: trunkId }),
    });
    return { assigned: true, reassigned: false };
  } catch (error) {
    if (!(error instanceof HttpError) || error.statusCode !== 400 || !/already assigned/i.test(error.message)) {
      throw error;
    }
  }

  await vobizRequest<Record<string, never>>(credentials, path, { method: "DELETE" });
  await vobizRequest<Record<string, never>>(credentials, path, {
    method: "POST",
    body: JSON.stringify({ trunk_group_id: trunkId }),
  });
  return { assigned: true, reassigned: true };
}

export async function unassignVobizNumberFromTrunk(
  credentials: VobizCredentials,
  phoneNumber: string,
) {
  const path = `/numbers/${encodeURIComponent(phoneNumber)}/assign`;
  try {
    await vobizRequest<Record<string, never>>(credentials, path, { method: "DELETE" });
    return { unassigned: true };
  } catch (error) {
    if (
      error instanceof HttpError
      && [400, 404, 409].includes(error.statusCode)
      && /not\s+assigned|not\s+found|no\s+assignment|not\s+linked/i.test(error.message)
    ) {
      return { unassigned: false };
    }
    throw error;
  }
}

export async function configureVobizLiveKitInbound(
  credentials: VobizCredentials,
  phoneNumber: string,
): Promise<VobizLiveKitInboundRoute> {
  await findVobizOwnedNumber(credentials, phoneNumber);

  const livekitSipUri = livekitProviderSipUri();
  const trunks = (await listVobizTrunks(credentials)).objects;
  const trunk = selectInboundTrunk(trunks, livekitSipUri);
  if (!trunk) {
    throw new HttpError(
      409,
      "No active inbound Vobiz trunk was found. Create one in Vobiz or set VOBIZ_INBOUND_TRUNK_ID.",
    );
  }

  await renameLegacyLiveKitTrunks(credentials, trunks, trunk.trunk_id);
  const updatedTrunk = await updateVobizTrunkInboundDestination(credentials, trunk, livekitSipUri);
  const assignment = await assignVobizNumberToTrunk(credentials, phoneNumber, trunk.trunk_id);

  return {
    trunkId: updatedTrunk.trunk_id || trunk.trunk_id,
    trunkName: updatedTrunk.name || trunk.name,
    livekitSipUri,
    inboundDestination: updatedTrunk.inbound_destination || vobizInboundDestination(livekitSipUri),
    assigned: assignment.assigned,
    reassigned: assignment.reassigned,
  };
}
