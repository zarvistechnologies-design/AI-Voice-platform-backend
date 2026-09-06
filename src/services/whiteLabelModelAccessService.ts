import { configuredModelCatalogSnapshot, defaultOpenAIRealtimeModel } from "./modelCatalog.js";
import { HttpError } from "../utils/httpError.js";

export const whiteLabelModelCategories = ["stt", "llm", "tts"] as const;
export type WhiteLabelModelCategory = typeof whiteLabelModelCategories[number];
export type WhiteLabelModelAccess = Record<WhiteLabelModelCategory, string[]>;

export type WhiteLabelModelOption = {
  key: string;
  category: WhiteLabelModelCategory;
  provider: string;
  model: string;
  label: string;
  kind: "realtime" | "pipeline";
};

type CatalogProvider = {
  provider: string;
  label: string;
  configured: boolean;
  models: readonly string[];
};

export function whiteLabelModelKey(provider: string, model: string) {
  return `${provider.trim().toLowerCase()}:${model.trim()}`;
}

export function whiteLabelModelCatalog(): Record<WhiteLabelModelCategory, WhiteLabelModelOption[]> {
  const catalog = configuredModelCatalogSnapshot().value;
  const options: Record<WhiteLabelModelCategory, WhiteLabelModelOption[]> = { stt: [], llm: [], tts: [] };
  const append = (
    category: WhiteLabelModelCategory,
    providers: readonly CatalogProvider[],
    kind: WhiteLabelModelOption["kind"],
  ) => {
    for (const provider of providers) {
      if (!provider.configured) continue;
      for (const model of provider.models) {
        options[category].push({
          key: whiteLabelModelKey(provider.provider, model),
          category,
          provider: provider.provider,
          model,
          label: `${provider.label} / ${model}`,
          kind,
        });
      }
    }
  };
  append("llm", catalog.realtime as readonly CatalogProvider[], "realtime");
  append("llm", catalog.llm as readonly CatalogProvider[], "pipeline");
  append("stt", catalog.stt as readonly CatalogProvider[], "pipeline");
  append("tts", catalog.tts as readonly CatalogProvider[], "pipeline");
  return options;
}

export function fullWhiteLabelModelAccess(): WhiteLabelModelAccess {
  const catalog = whiteLabelModelCatalog();
  return Object.fromEntries(
    whiteLabelModelCategories.map((category) => [category, catalog[category].map((item) => item.key)]),
  ) as WhiteLabelModelAccess;
}

export function whiteLabelModelCatalogForAccess(access: WhiteLabelModelAccess | undefined) {
  const catalog = whiteLabelModelCatalog();
  if (!access) return catalog;
  return Object.fromEntries(
    whiteLabelModelCategories.map((category) => {
      const allowed = new Set(access[category] ?? []);
      return [category, catalog[category].filter((item) => allowed.has(item.key))];
    }),
  ) as Record<WhiteLabelModelCategory, WhiteLabelModelOption[]>;
}

export function parseWhiteLabelModelAccess(
  value: unknown,
  options: { optional?: boolean; fallback?: WhiteLabelModelAccess } = {},
): WhiteLabelModelAccess | undefined {
  if (value === undefined || value === null) {
    if (options.fallback) return options.fallback;
    if (options.optional) return undefined;
  }
  const input = (value ?? {}) as Record<string, unknown>;
  const catalog = whiteLabelModelCatalog();
  const parsed = {} as WhiteLabelModelAccess;
  for (const category of whiteLabelModelCategories) {
    const raw = input[category];
    if (!Array.isArray(raw)) throw new HttpError(400, `${category.toUpperCase()} model access must be a list.`);
    const valid = new Set(catalog[category].map((item) => item.key));
    const keys = [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
    if (keys.length > 500) throw new HttpError(400, `Too many ${category.toUpperCase()} models were selected.`);
    const unknown = keys.find((key) => !valid.has(key));
    if (unknown) throw new HttpError(400, `Unknown or unconfigured ${category.toUpperCase()} model: ${unknown}.`);
    parsed[category] = keys;
  }
  return parsed;
}

export function assertWhiteLabelModelAccessSubset(
  selected: WhiteLabelModelAccess | undefined,
  ceiling: WhiteLabelModelAccess | undefined,
) {
  if (!selected || !ceiling) return;
  for (const category of whiteLabelModelCategories) {
    const allowed = new Set(ceiling[category] ?? []);
    const disallowed = (selected[category] ?? []).find((key) => !allowed.has(key));
    if (disallowed) {
      throw new HttpError(409, `${category.toUpperCase()} model ${disallowed} is not allowed by the platform contract.`);
    }
  }
}

export function effectiveWhiteLabelModelAccess(
  selected: WhiteLabelModelAccess | undefined,
  ceiling: WhiteLabelModelAccess | undefined,
) {
  return selected ?? ceiling;
}

type AgentModelStack = {
  pipelineMode?: unknown;
  realtimeProvider?: unknown;
  realtimeModel?: unknown;
  llmProvider?: unknown;
  llmModel?: unknown;
  sttProvider?: unknown;
  sttModel?: unknown;
  ttsProvider?: unknown;
  ttsModel?: unknown;
};

export function assertAgentModelsAllowed(
  access: WhiteLabelModelAccess | undefined,
  agent: AgentModelStack,
) {
  if (!access) return;
  const check = (category: WhiteLabelModelCategory, provider: unknown, model: unknown) => {
    const key = whiteLabelModelKey(String(provider ?? ""), String(model ?? ""));
    if (!(access[category] ?? []).includes(key)) {
      throw new HttpError(403, `${category.toUpperCase()} model ${key} is not included in this customer plan.`);
    }
  };
  if (agent.pipelineMode === "realtime") {
    check("llm", agent.realtimeProvider, agent.realtimeModel);
    return;
  }
  check("stt", agent.sttProvider, agent.sttModel);
  check("llm", agent.llmProvider, agent.llmModel);
  check("tts", agent.ttsProvider, agent.ttsModel);
}

export function defaultAgentModelStack(access: WhiteLabelModelAccess | undefined) {
  const defaults = {
    pipelineMode: "realtime" as const,
    realtimeProvider: "openai",
    realtimeModel: defaultOpenAIRealtimeModel,
    llmProvider: "openai",
    llmModel: "gpt-4.1-mini",
    sttProvider: "openai",
    sttModel: "gpt-4o-mini-transcribe",
    ttsProvider: "openai",
    ttsModel: "gpt-4o-mini-tts",
  };
  if (!access) return defaults;
  const catalog = whiteLabelModelCatalog();
  const defaultRealtimeKey = whiteLabelModelKey(defaults.realtimeProvider, defaults.realtimeModel);
  const realtime = catalog.llm.find((item) =>
    item.kind === "realtime" && (access.llm ?? []).includes(item.key) && item.key === defaultRealtimeKey,
  ) ?? catalog.llm.find((item) => item.kind === "realtime" && (access.llm ?? []).includes(item.key));
  if (realtime) {
    return {
      ...defaults,
      realtimeProvider: realtime.provider,
      realtimeModel: realtime.model,
    };
  }
  const stt = catalog.stt.find((item) => (access.stt ?? []).includes(item.key));
  const llm = catalog.llm.find((item) => item.kind === "pipeline" && (access.llm ?? []).includes(item.key));
  const tts = catalog.tts.find((item) => (access.tts ?? []).includes(item.key));
  if (!stt || !llm || !tts) {
    throw new HttpError(409, "This plan does not contain a complete realtime or STT/LLM/TTS model stack.");
  }
  return {
    ...defaults,
    pipelineMode: "pipeline" as const,
    sttProvider: stt.provider,
    sttModel: stt.model,
    llmProvider: llm.provider,
    llmModel: llm.model,
    ttsProvider: tts.provider,
    ttsModel: tts.model,
  };
}

export function filterModelCatalogForAccess<T>(catalogValue: T, access: WhiteLabelModelAccess | undefined): T {
  if (!access || !catalogValue || typeof catalogValue !== "object") return catalogValue;
  const catalog = catalogValue as Record<string, unknown>;
  const filterProviders = (value: unknown, category: WhiteLabelModelCategory) => {
    if (!Array.isArray(value)) return value;
    const allowed = new Set(access[category] ?? []);
    return value.flatMap((rawProvider) => {
      const provider = rawProvider as Record<string, unknown>;
      const providerId = String(provider.provider ?? "");
      const models = Array.isArray(provider.models)
        ? provider.models.filter((model) => allowed.has(whiteLabelModelKey(providerId, String(model))))
        : [];
      return models.length ? [{ ...provider, models }] : [];
    });
  };
  return {
    ...catalog,
    realtime: filterProviders(catalog.realtime, "llm"),
    llm: filterProviders(catalog.llm, "llm"),
    stt: filterProviders(catalog.stt, "stt"),
    tts: filterProviders(catalog.tts, "tts"),
  } as T;
}
