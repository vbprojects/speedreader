import { ForeignLibraryRegistry } from "./registry";
import { ForeignLibraryError, type ForeignDownloadPlan, type ForeignImportPlan } from "./types";

const FALLBACK_ERROR_CODES = new Set([
  "network-unavailable",
  "cors-blocked",
  "rate-limited",
  "acquisition-failed",
]);

export interface ManualForeignDownload {
  plan: ForeignDownloadPlan;
  url: string;
  fileName: string;
  action: "download" | "source-page";
}

export function manualForeignDownload(
  plan: ForeignImportPlan,
  registry: ForeignLibraryRegistry,
  error?: unknown,
): ManualForeignDownload | null {
  if (plan.kind !== "download" || plan.request.credential
    || (plan.request.method ?? "GET") !== "GET" || plan.request.body !== undefined) {
    return null;
  }
  const validated = registry.validatePlan(plan);
  if (validated.kind !== "download") return null;
  const manual = validated.acquisition === "manual";
  // Twine gateway URLs are opaque IFDB resolver requests, not downloadable
  // source files. The Twine item always exposes a separate source-page offer.
  if (!manual && validated.request.gateway?.route === "twine") return null;
  if (!manual && (!validated.request.gateway
    || !(error instanceof ForeignLibraryError) || !FALLBACK_ERROR_CODES.has(error.code))) return null;
  const manifest = registry.manifest(plan.provenance.libraryId);
  let url: URL;
  try {
    url = new URL(plan.request.url);
  } catch {
    return null;
  }
  const allowedOrigins = manual ? manifest.permissions.manualDownloadOrigins ?? [] : manifest.permissions.networkOrigins;
  if (url.protocol !== "https:" || url.username || url.password || !allowedOrigins.includes(url.origin)) {
    return null;
  }
  return { plan, url: url.toString(), fileName: plan.file.name, action: plan.manualAction ?? "download" };
}
