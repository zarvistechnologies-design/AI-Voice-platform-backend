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

type VobizTrunk = {
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
  const response = await fetch(
    `${env.vobizBaseUrl.replace(/\/$/, "")}/v1/Account/${encodeURIComponent(credentials.authId)}${path}`,
    {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Auth-ID": credentials.authId,
        "X-Auth-Token": credentials.authToken,
        ...init.headers,
      },
    },
  );
  const body = (await response.json().catch(() => null)) as
    | (T & { message?: string; error?: string })
    | null;

  if (!response.ok) {
    throw new HttpError(
      response.status,
      body?.message ?? body?.error ?? `Vobiz request failed with status ${response.status}.`,
    );
  }
  if (response.status === 204) return {} as T;
  if (!body) {
    throw new HttpError(502, "Vobiz returned an empty response.");
  }
  return body;
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
  return `sip:${destination}:5060`;
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
      "Set LIVEKIT_SIP_URI to your LiveKit SIP endpoint, for example sip:your-project.sip.livekit.cloud.",
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
    description: "LiveKit inbound SIP",
  };

  if (trunk.primary_uri_uuid) {
    return vobizRequest<VobizOriginationUri>(
      credentials,
      `/trunks/${encodeURIComponent(trunk.trunk_id)}/origination-uris/${encodeURIComponent(trunk.primary_uri_uuid)}`,
      {
        method: "PUT",
        body: JSON.stringify(payload),
      },
    );
  }

  return vobizRequest<VobizOriginationUri>(
    credentials,
    `/trunks/${encodeURIComponent(trunk.trunk_id)}/origination-uris`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export async function listVobizOwnedNumbers(
  credentials: VobizCredentials,
  page = 1,
  perPage = 100,
) {
  return vobizRequest<VobizListResponse>(
    credentials,
    `/numbers?page=${Math.max(1, page)}&per_page=${Math.min(100, Math.max(1, perPage))}`,
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

export async function findVobizOwnedNumber(credentials: VobizCredentials, e164: string) {
  let page = 1;
  do {
    const response = await listVobizOwnedNumbers(credentials, page, 100);
    const number = response.items.find((item) => item.e164 === e164);
    if (number) return number;
    if (page * response.per_page >= response.total) break;
    page += 1;
  } while (page <= 20);

  throw new HttpError(
    404,
    "Vobiz did not return this number as an active owned number. Trial numbers cannot be used for inbound routing; complete Vobiz verification or purchase a full inbound DID, then sync phone numbers.",
  );
}

export async function purchaseVobizNumber(
  credentials: VobizCredentials,
  e164: string,
  currency?: string,
) {
  const response = await vobizRequest<VobizPurchaseResponse>(
    credentials,
    "/numbers/purchase-from-inventory",
    {
      method: "POST",
      body: JSON.stringify({ e164, ...(currency ? { currency } : {}) }),
    },
  );
  const number = response.number ?? response.items?.find((item) => item.e164 === e164);
  if (!number) {
    throw new HttpError(502, "Vobiz purchased the number but did not return its details.");
  }
  return number;
}

export async function listVobizTrunks(credentials: VobizCredentials) {
  return vobizRequest<VobizTrunkListResponse>(credentials, "/trunks?limit=100&offset=0");
}

export async function updateVobizTrunkInboundDestination(
  credentials: VobizCredentials,
  trunk: VobizTrunk,
  inboundDestination: string,
) {
  const destination = vobizInboundDestination(inboundDestination);
  const originationUri = vobizOriginationUri(inboundDestination);
  const uri = await upsertVobizOriginationUri(credentials, trunk, originationUri);

  return vobizRequest<VobizTrunk>(credentials, `/trunks/${encodeURIComponent(trunk.trunk_id)}`, {
    method: "PUT",
    body: JSON.stringify({
      name: trunk.name,
      max_concurrent_calls: trunk.concurrent_calls_limit,
      enabled: trunk.trunk_status !== "inactive",
      primary_uri_uuid: uri.id,
      inbound_destination: destination,
    }),
  });
}

export async function assignVobizNumberToTrunk(
  credentials: VobizCredentials,
  phoneNumber: string,
  trunkId: string,
) {
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

export async function configureVobizLiveKitInbound(
  credentials: VobizCredentials,
  phoneNumber: string,
): Promise<VobizLiveKitInboundRoute> {
  await findVobizOwnedNumber(credentials, phoneNumber);

  const livekitSipUri = livekitProviderSipUri();
  const trunk = selectInboundTrunk((await listVobizTrunks(credentials)).objects, livekitSipUri);
  if (!trunk) {
    throw new HttpError(
      409,
      "No active inbound Vobiz trunk was found. Create one in Vobiz or set VOBIZ_INBOUND_TRUNK_ID.",
    );
  }

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
