import { OPENAI_COMPATIBLE_FORMAT } from "../ingestion/openai-compatible";
import {
  FOREIGN_LIBRARY_API,
  ForeignLibraryError,
  type ForeignBrowseRequest,
  type ForeignImportPlan,
  type ForeignItem,
  type ForeignItemRef,
  type ForeignLibraryHost,
  type ForeignLibraryManifest,
  type ForeignLibraryPlugin,
  type ForeignLibrarySession,
  type ForeignPage,
  type ForeignSearchRequest,
  type Json,
} from "./types";

const OPENROUTER_ORIGIN = "https://openrouter.ai";
const MODELS_URL = `${OPENROUTER_ORIGIN}/api/v1/models`;
const OPENROUTER_BASE_URL = `${OPENROUTER_ORIGIN}/api/v1`;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_SIZE = 50;
const ALLOWED_CURSOR_PARAMETERS = new Set(["limit", "offset", "output_modalities", "q", "sort"]);

export const OPENROUTER_LIBRARY_ID = "ai.openrouter.models";
export const OPENROUTER_MODEL_OUTPUT = "x-llm-model" as const;

interface OpenRouterModel {
  id?: unknown;
  canonical_slug?: unknown;
  name?: unknown;
  created?: unknown;
  description?: unknown;
  context_length?: unknown;
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
    tokenizer?: unknown;
  };
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
    request?: unknown;
  };
  supported_parameters?: unknown;
  reasoning?: unknown;
}

interface OpenRouterModelsResponse {
  data?: unknown;
  total_count?: unknown;
  links?: { next?: unknown };
}

function string(value: unknown, max = 4096): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
}

function stringArray(value: unknown, max = 128): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).flatMap((entry) => {
    const item = string(entry, 128);
    return item ? [item] : [];
  });
}

function providerName(modelId: string): string {
  const provider = modelId.split("/", 1)[0] || "OpenRouter";
  return provider.split(/[-_]/u).map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function price(value: unknown): string | undefined {
  const candidate = string(value, 64);
  if (!candidate || !Number.isFinite(Number(candidate)) || Number(candidate) < 0) return undefined;
  return candidate;
}

function modelItem(model: OpenRouterModel): ForeignItem | null {
  const id = string(model.id, 512);
  const title = string(model.name, 512);
  if (!id || !title || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/iu.test(id)) return null;
  const inputModalities = stringArray(model.architecture?.input_modalities, 16);
  const outputModalities = stringArray(model.architecture?.output_modalities, 16);
  const supportedParameters = stringArray(model.supported_parameters);
  const contextLength = Number(model.context_length);
  const created = Number(model.created);
  const validCreated = Number.isSafeInteger(created) && created > 0 && created <= 4_102_444_800;
  const promptPrice = price(model.pricing?.prompt);
  const completionPrice = price(model.pricing?.completion);
  const requestPrice = price(model.pricing?.request);
  const metadata: Record<string, Json> = {
    inputModalities,
    outputModalities,
    supportedParameters,
  };
  if (Number.isSafeInteger(contextLength) && contextLength > 0) metadata.contextLength = contextLength;
  if (string(model.architecture?.tokenizer, 128)) metadata.tokenizer = string(model.architecture?.tokenizer, 128)!;
  if (promptPrice || completionPrice || requestPrice) {
    metadata.pricing = {
      ...(promptPrice ? { prompt: promptPrice } : {}),
      ...(completionPrice ? { completion: completionPrice } : {}),
      ...(requestPrice ? { request: requestPrice } : {}),
    };
  }
  if (model.reasoning && typeof model.reasoning === "object") metadata.reasoning = true;
  const subjects = [
    ...inputModalities.map((modality) => `${modality} input`),
    ...(supportedParameters.includes("tools") ? ["tool use"] : []),
    ...(model.reasoning ? ["reasoning"] : []),
    ...(promptPrice === "0" && completionPrice === "0" ? ["free"] : []),
  ];
  return {
    ref: {
      libraryId: OPENROUTER_LIBRARY_ID,
      itemId: id,
      revision: string(model.canonical_slug, 512) ?? (validCreated ? String(created) : undefined),
    },
    kind: "model",
    title,
    authors: [providerName(id)],
    ...(string(model.description, 4_000) ? { summary: string(model.description, 4_000) } : {}),
    ...(validCreated ? { publishedAt: new Date(created * 1000).toISOString() } : {}),
    canonicalUrl: `${OPENROUTER_ORIGIN}/${id}`,
    ...(subjects.length ? { subjects } : {}),
    offers: [{
      id: "add-model",
      label: "Add model to LLM Chat",
      outputType: OPENROUTER_MODEL_OUTPUT,
      importKind: "interactive",
      risk: "remote-service",
    }],
    metadata,
  };
}

function catalogCursor(value: string): URL {
  let url: URL;
  try {
    url = new URL(value, OPENROUTER_ORIGIN);
  } catch {
    throw new ForeignLibraryError("invalid-request", "The OpenRouter result cursor is invalid.");
  }
  const keys = [...url.searchParams.keys()];
  if (url.origin !== OPENROUTER_ORIGIN || url.pathname !== "/api/v1/models" || url.username || url.password || url.hash
    || new Set(keys).size !== keys.length || keys.some((key) => !ALLOWED_CURSOR_PARAMETERS.has(key))) {
    throw new ForeignLibraryError("invalid-request", "The OpenRouter result cursor is invalid.");
  }
  const limit = Number(url.searchParams.get("limit") ?? "24");
  const offset = Number(url.searchParams.get("offset") ?? "0");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE
    || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000
    || url.searchParams.get("sort") !== "most-popular"
    || url.searchParams.get("output_modalities") !== "text"
    || (url.searchParams.get("q")?.length ?? 0) > 256) {
    throw new ForeignLibraryError("invalid-request", "The OpenRouter result cursor is invalid.");
  }
  return url;
}

export class OpenRouterForeignLibrary implements ForeignLibraryPlugin {
  readonly manifest: ForeignLibraryManifest = {
    apiVersion: FOREIGN_LIBRARY_API,
    id: OPENROUTER_LIBRARY_ID,
    version: "1.0.0",
    name: "OpenRouter Models",
    description: "Browse and add OpenRouter models as reusable LLM Chat entries. API keys remain in Speedreader's existing connection flow.",
    homepage: `${OPENROUTER_ORIGIN}/models`,
    capabilities: ["catalog.search", "catalog.browse", "item.resolve", "item.acquire"],
    outputs: [{ type: OPENROUTER_MODEL_OUTPUT, label: "LLM model", delivery: ["interactive"] }],
    permissions: {
      networkOrigins: [OPENROUTER_ORIGIN],
      credentials: [{
        id: "openrouter-api-key",
        label: "OpenRouter API key",
        kind: "api-key",
        required: true,
        allowEncryptedStorage: true,
      }],
      rateLimit: { maxConcurrent: 1, minIntervalMs: 200 },
      maxResponseBytes: MAX_CATALOG_BYTES,
    },
  };

  async open(host: ForeignLibraryHost): Promise<ForeignLibrarySession> {
    const cached = new Map<string, ForeignItem>();

    const fetchModels = async (url: URL, signal?: AbortSignal): Promise<ForeignPage<ForeignItem>> => {
      const response = await host.request({
        url: url.toString(),
        signal,
        timeoutMs: 30_000,
        maxResponseBytes: MAX_CATALOG_BYTES,
        headers: { Accept: "application/json" },
      });
      if (response.status !== 200) {
        throw new ForeignLibraryError("acquisition-failed", `OpenRouter returned ${response.status} ${response.statusText}`.trim(), response.status >= 500);
      }
      let decoded: OpenRouterModelsResponse;
      try {
        decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)) as OpenRouterModelsResponse;
      } catch {
        throw new ForeignLibraryError("invalid-response", "OpenRouter returned invalid model JSON.");
      }
      if (!Array.isArray(decoded.data)) throw new ForeignLibraryError("invalid-response", "OpenRouter returned an invalid model catalog.");
      const items = decoded.data.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const item = modelItem(entry as OpenRouterModel);
        if (!item) return [];
        cached.set(item.ref.itemId, item);
        return [item];
      });
      const next = string(decoded.links?.next, 2_048);
      const total = Number(decoded.total_count);
      return {
        items,
        ...(next ? { nextCursor: catalogCursor(next).toString() } : {}),
        ...(Number.isSafeInteger(total) && total >= 0 ? { total } : {}),
      };
    };

    const pageUrl = (cursor: string | undefined, pageSize: number, query?: string): URL => {
      if (cursor) return catalogCursor(cursor);
      const url = new URL(MODELS_URL);
      url.searchParams.set("limit", String(Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE)));
      url.searchParams.set("sort", "most-popular");
      url.searchParams.set("output_modalities", "text");
      if (query) url.searchParams.set("q", query);
      return url;
    };

    const resolve = async (ref: ForeignItemRef): Promise<ForeignItem> => {
      if (ref.libraryId !== OPENROUTER_LIBRARY_ID || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/iu.test(ref.itemId)) {
        throw new ForeignLibraryError("invalid-request", "The model has an invalid OpenRouter identifier.");
      }
      const existing = cached.get(ref.itemId);
      if (existing) return existing;
      const page = await fetchModels(pageUrl(undefined, 25, ref.itemId));
      const item = page.items.find((candidate) => candidate.ref.itemId === ref.itemId);
      if (!item) throw new ForeignLibraryError("not-found", "OpenRouter could not find this model.");
      return item;
    };

    return {
      browse: (request: ForeignBrowseRequest) =>
        fetchModels(pageUrl(request.cursor, request.pageSize ?? 24), request.signal),
      search: (request: ForeignSearchRequest) => {
        const query = request.query.trim();
        if (!query) throw new ForeignLibraryError("invalid-request", "Enter a model or provider to search OpenRouter.");
        if (query.length > 256) throw new ForeignLibraryError("invalid-request", "The OpenRouter search is too long.");
        return fetchModels(pageUrl(request.cursor, request.pageSize ?? 24, query), request.signal);
      },
      resolve,
      async planImport(ref, offerId): Promise<ForeignImportPlan> {
        if (offerId !== "add-model") throw new ForeignLibraryError("not-found", "The selected OpenRouter model offer is unavailable.");
        const item = await resolve(ref);
        return {
          kind: "interactive",
          format: OPENAI_COMPATIBLE_FORMAT,
          publicConfig: { baseUrl: OPENROUTER_BASE_URL, model: item.ref.itemId },
          credentialBindings: { apiKey: "openrouter-api-key" },
          suggestedTitle: item.title,
          suggestedAuthor: `${item.authors?.[0] ?? "OpenRouter"} via OpenRouter`,
          provenance: {
            libraryId: OPENROUTER_LIBRARY_ID,
            itemId: item.ref.itemId,
            revision: item.ref.revision,
            canonicalUrl: item.canonicalUrl,
          },
        };
      },
      dispose: () => cached.clear(),
    };
  }
}
