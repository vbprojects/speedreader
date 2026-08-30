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
}

export function manualForeignDownload(
  plan: ForeignImportPlan,
  registry: ForeignLibraryRegistry,
  error: unknown,
): ManualForeignDownload | null {
  if (plan.kind !== "download" || plan.request.gateway !== "preferred" || plan.request.credential
    || (plan.request.method ?? "GET") !== "GET" || plan.request.body !== undefined
    || !(error instanceof ForeignLibraryError) || !FALLBACK_ERROR_CODES.has(error.code)) {
    return null;
  }
  registry.validatePlan(plan);
  const manifest = registry.manifest(plan.provenance.libraryId);
  let url: URL;
  try {
    url = new URL(plan.request.url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || !manifest.permissions.networkOrigins.includes(url.origin)) {
    return null;
  }
  return { plan, url: url.toString(), fileName: plan.file.name };
}
