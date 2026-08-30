import {
  FOREIGN_LIBRARY_API,
  ForeignLibraryError,
  type ForeignCapability,
  type ForeignImportPlan,
  type ForeignItem,
  type ForeignLibraryManifest,
  type ForeignOutputType,
} from "./types";

const CAPABILITIES = new Set<ForeignCapability>([
  "catalog.search",
  "catalog.browse",
  "item.resolve",
  "item.acquire",
]);
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/u;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const OUTPUT_TYPE_PATTERN = /^(?:epub|html|pdf|json|sugarcube|x-[a-z0-9]+(?:[._-][a-z0-9]+)*)$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu;
const EXTENSION_PATTERN = /^[a-z0-9]+$/iu;

function invalid(message: string): never {
  throw new ForeignLibraryError("invalid-response", message);
}

function nonEmpty(value: unknown, label: string, max = 512): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalid(`${label} is invalid`);
}

function httpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid("Network permission contains an invalid URL");
  }
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    invalid("Network permissions must be exact HTTPS origins");
  }
  return url.origin;
}

function assertJson(value: unknown, label: string, depth = 0, seen = new Set<object>()): void {
  if (depth > 32) invalid(`${label} is nested too deeply`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") invalid(`${label} is not JSON-safe`);
  if (seen.has(value)) invalid(`${label} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 10_000) invalid(`${label} contains too many items`);
    value.forEach((entry) => assertJson(entry, label, depth + 1, seen));
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid(`${label} contains a non-plain object`);
    const entries = Object.entries(value);
    if (entries.length > 10_000) invalid(`${label} contains too many properties`);
    entries.forEach(([key, entry]) => {
      nonEmpty(key, `${label} property`, 512);
      assertJson(entry, label, depth + 1, seen);
    });
  }
  seen.delete(value);
}

export function validateForeignManifest(manifest: ForeignLibraryManifest): ForeignLibraryManifest {
  if (manifest?.apiVersion !== FOREIGN_LIBRARY_API) invalid("Unsupported Foreign Library API version");
  nonEmpty(manifest.id, "Plugin ID", 128);
  if (!ID_PATTERN.test(manifest.id)) invalid("Plugin ID must be a namespaced lowercase identifier");
  nonEmpty(manifest.version, "Plugin version", 64);
  if (!SEMVER_PATTERN.test(manifest.version)) invalid("Plugin version must use semantic versioning");
  nonEmpty(manifest.name, "Plugin name", 128);
  nonEmpty(manifest.description, "Plugin description", 1024);
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) invalid("Plugin has no capabilities");
  if (new Set(manifest.capabilities).size !== manifest.capabilities.length || manifest.capabilities.some((item) => !CAPABILITIES.has(item))) {
    invalid("Plugin capabilities are invalid or duplicated");
  }
  if (!manifest.capabilities.includes("item.resolve") || !manifest.capabilities.includes("item.acquire")) {
    invalid("Plugins must resolve and acquire items");
  }
  if (!Array.isArray(manifest.outputs) || manifest.outputs.length === 0 || manifest.outputs.length > 32) {
    invalid("Plugin output declarations are invalid");
  }
  if (new Set(manifest.outputs.map((output) => output.type)).size !== manifest.outputs.length) {
    invalid("Plugin output types must be unique");
  }
  for (const output of manifest.outputs) {
    nonEmpty(output.type, "Plugin output type", 128);
    if (!OUTPUT_TYPE_PATTERN.test(output.type)) invalid("Plugin output type is invalid");
    nonEmpty(output.label, "Plugin output label", 128);
    if (!Array.isArray(output.delivery) || output.delivery.length === 0
      || new Set(output.delivery).size !== output.delivery.length
      || output.delivery.some((kind) => kind !== "download" && kind !== "interactive")) {
      invalid("Plugin output delivery modes are invalid");
    }
    const mediaTypes = output.mediaTypes ?? [];
    if (!Array.isArray(mediaTypes) || mediaTypes.length > 32
      || new Set(mediaTypes.map((value) => value.toLowerCase())).size !== mediaTypes.length
      || mediaTypes.some((value) => typeof value !== "string" || !MEDIA_TYPE_PATTERN.test(value))) {
      invalid("Plugin output media types are invalid");
    }
    const extensions = output.extensions ?? [];
    if (!Array.isArray(extensions) || extensions.length > 32
      || new Set(extensions.map((value) => value.toLowerCase())).size !== extensions.length
      || extensions.some((value) => typeof value !== "string" || !EXTENSION_PATTERN.test(value))) {
      invalid("Plugin output extensions are invalid");
    }
  }
  const origins = manifest.permissions?.networkOrigins;
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > 32) invalid("Plugin must declare network origins");
  const normalizedOrigins = origins.map(httpsOrigin);
  if (new Set(normalizedOrigins).size !== normalizedOrigins.length) invalid("Network origins must be unique");
  const manualOrigins = manifest.permissions.manualDownloadOrigins ?? [];
  if (!Array.isArray(manualOrigins) || manualOrigins.length > 32) invalid("Manual download origins are invalid");
  const normalizedManualOrigins = manualOrigins.map(httpsOrigin);
  if (new Set(normalizedManualOrigins).size !== normalizedManualOrigins.length) invalid("Manual download origins must be unique");
  const maxBytes = manifest.permissions.maxResponseBytes;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) invalid("Maximum response bytes is invalid");
  const rate = manifest.permissions.rateLimit;
  if (rate && (!Number.isSafeInteger(rate.maxConcurrent) || rate.maxConcurrent < 1 || rate.maxConcurrent > 16
    || !Number.isSafeInteger(rate.minIntervalMs) || rate.minIntervalMs < 0)) {
    invalid("Rate limit is invalid");
  }
  const slots = manifest.permissions.credentials ?? [];
  if (new Set(slots.map((slot) => slot.id)).size !== slots.length) invalid("Credential slot IDs must be unique");
  for (const slot of slots) {
    nonEmpty(slot.id, "Credential slot ID", 64);
    nonEmpty(slot.label, "Credential slot label", 128);
    if (!(["api-key", "bearer-token", "oauth2"] as const).includes(slot.kind)) invalid("Credential kind is invalid");
  }
  return manifest;
}

export function validateForeignItem(item: ForeignItem, manifest: ForeignLibraryManifest): ForeignItem {
  if (!item || item.ref?.libraryId !== manifest.id) invalid("Foreign item belongs to the wrong plugin");
  nonEmpty(item.ref.itemId, "Foreign item ID", 512);
  nonEmpty(item.title, "Foreign item title", 2048);
  if (item.authors !== undefined && (!Array.isArray(item.authors) || item.authors.length > 256)) invalid("Foreign item authors are invalid");
  item.authors?.forEach((author) => nonEmpty(author, "Foreign item author", 512));
  if (!(["book", "paper", "model", "feed", "application"] as const).includes(item.kind)) invalid("Foreign item kind is invalid");
  if (!Array.isArray(item.offers) || item.offers.length > 64) invalid("Foreign item offers are invalid");
  if (new Set(item.offers.map((offer) => offer.id)).size !== item.offers.length) invalid("Foreign offer IDs must be unique");
  const declaredOutputs = new Map<ForeignOutputType, ForeignLibraryManifest["outputs"][number]>(
    manifest.outputs.map((output) => [output.type, output]),
  );
  for (const offer of item.offers) {
    nonEmpty(offer.id, "Foreign offer ID", 256);
    nonEmpty(offer.label, "Foreign offer label", 256);
    nonEmpty(offer.outputType, "Foreign offer output type", 128);
    if (offer.importKind !== "download" && offer.importKind !== "interactive") invalid("Foreign offer kind is invalid");
    const output = declaredOutputs.get(offer.outputType);
    if (!output) invalid("Foreign offer references an undeclared output type");
    if (!output.delivery.includes(offer.importKind)) invalid("Foreign offer uses an undeclared delivery mode");
    if (offer.mediaType && output.mediaTypes?.length
      && !output.mediaTypes.some((value) => value.toLowerCase() === offer.mediaType?.toLowerCase())) {
      invalid("Foreign offer uses an undeclared media type");
    }
    if (offer.extension && output.extensions?.length
      && !output.extensions.some((value) => value.toLowerCase() === offer.extension?.toLowerCase())) {
      invalid("Foreign offer uses an undeclared extension");
    }
    if (offer.byteLength !== undefined && (!Number.isSafeInteger(offer.byteLength) || offer.byteLength < 0)) invalid("Foreign offer size is invalid");
  }
  if (item.metadata !== undefined) assertJson(item.metadata, "Foreign item metadata");
  return item;
}

export function validateForeignImportPlan(plan: ForeignImportPlan, manifest: ForeignLibraryManifest): ForeignImportPlan {
  if (!plan || plan.provenance?.libraryId !== manifest.id) invalid("Import plan belongs to the wrong plugin");
  nonEmpty(plan.provenance.itemId, "Provenance item ID", 512);
  if (plan.kind === "download") {
    nonEmpty(plan.request?.url, "Download URL", 4096);
    if (plan.acquisition !== undefined && plan.acquisition !== "host" && plan.acquisition !== "manual") invalid("Download acquisition mode is invalid");
    if (plan.request.gateway !== undefined
      && (typeof plan.request.gateway !== "object" || !(["gutenberg", "catalog"] as const).includes(plan.request.gateway.route))) {
      invalid("Download gateway preference is invalid");
    }
    nonEmpty(plan.file?.name, "Download filename", 512);
    nonEmpty(plan.file?.extension, "Download extension", 32);
    if (!/^[a-z0-9]+$/iu.test(plan.file.extension) || /[\\/\0]/u.test(plan.file.name)) invalid("Download filename is invalid");
    if (plan.file.expectedSha256 && !/^[a-f0-9]{64}$/iu.test(plan.file.expectedSha256)) invalid("Expected file hash is invalid");
    if (plan.acquisition === "manual") {
      let source: URL;
      try {
        source = new URL(plan.request.url);
      } catch {
        invalid("Manual download URL is invalid");
      }
      if ((plan.request.method && plan.request.method !== "GET") || plan.request.body || plan.request.credential || plan.request.gateway) {
        invalid("Manual downloads must be unauthenticated direct GET requests");
      }
      if (source.protocol !== "https:" || source.username || source.password
        || !(manifest.permissions.manualDownloadOrigins ?? []).includes(source.origin)) {
        invalid("Manual download uses an undeclared origin");
      }
    }
  } else if (plan.kind === "interactive") {
    nonEmpty(plan.format, "Interactive format", 128);
    nonEmpty(plan.suggestedTitle, "Interactive title", 512);
    assertJson(plan.publicConfig, "Interactive public configuration");
    for (const [binding, slot] of Object.entries(plan.credentialBindings ?? {})) {
      nonEmpty(binding, "Credential binding", 128);
      nonEmpty(slot, "Credential slot reference", 128);
    }
  } else {
    invalid("Import plan kind is invalid");
  }
  return plan;
}
