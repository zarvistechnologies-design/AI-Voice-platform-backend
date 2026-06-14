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
  if (!body) {
    throw new HttpError(502, "Vobiz returned an empty response.");
  }
  return body;
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

  throw new HttpError(404, "That number is not owned by the configured Vobiz account.");
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
