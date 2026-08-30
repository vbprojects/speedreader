import { INGESTION_LIMITS } from "../ingestion/limits";
import {
  ForeignLibraryError,
  type ForeignCredentialSlot,
  type ForeignLibraryHost,
  type ForeignLibraryManifest,
  type ForeignRequest,
  type ForeignResponse,
} from "./types";

export type ForeignFetch = typeof fetch;
export type ForeignCredentialResolver = (
  manifest: ForeignLibraryManifest,
  slot: ForeignCredentialSlot,
) => Promise<string | null>;

const GATEWAY_SOURCE_HEADER = "x-speedreader-source-url";

const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "referer",
  "set-cookie",
]);

function abortError(): ForeignLibraryError {
  return new ForeignLibraryError("cancelled", "The request was cancelled.");
}

function assertAllowedUrl(raw: string, manifest: ForeignLibraryManifest): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ForeignLibraryError("invalid-request", "The plugin requested an invalid URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || !manifest.permissions.networkOrigins.includes(url.origin)) {
    throw new ForeignLibraryError("permission-denied", `${manifest.name} is not permitted to contact ${url.origin}.`);
  }
  return url;
}

function gatewayEndpoint(raw: string | undefined): URL | undefined {
  if (!raw?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const loopbackHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if ((!loopbackHttp && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    return undefined;
  }
  return url;
}

function gatewayRoute(endpoint: URL, route: NonNullable<ForeignRequest["gateway"]>["route"]): URL {
  const url = new URL(endpoint);
  const trimmed = url.pathname.replace(/\/+$/u, "");
  if (/\/v1\/(?:gutenberg|catalog)$/u.test(trimmed)) {
    url.pathname = trimmed.replace(/(?:gutenberg|catalog)$/u, route);
  } else if (trimmed.endsWith("/v1")) {
    url.pathname = `${trimmed}/${route}`;
  } else {
    url.pathname = `${trimmed}/v1/${route}`;
  }
  return url;
}

function responseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => { result[key.toLowerCase()] = value; });
  return result;
}

async function readLimited(response: Response, limit: number): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new ForeignLibraryError("response-too-large", `The remote response exceeds the ${limit.toLocaleString()} byte limit.`);
  }
  if (!response.body) {
    const body = await response.arrayBuffer();
    if (body.byteLength > limit) throw new ForeignLibraryError("response-too-large", "The remote response is too large.");
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ForeignLibraryError("response-too-large", `The remote response exceeds the ${limit.toLocaleString()} byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class ConstrainedForeignLibraryHost implements ForeignLibraryHost {
  private queue = Promise.resolve();
  private nextRequestAt = 0;
  private readonly fetchImpl: ForeignFetch;
  private readonly gateway?: URL;

  constructor(
    private readonly manifest: ForeignLibraryManifest,
    fetchImpl: ForeignFetch = globalThis.fetch,
    private readonly resolveCredential?: ForeignCredentialResolver,
    gatewayUrl?: string,
  ) {
    // Window.fetch performs a Web IDL receiver check in browsers. Storing the
    // bare function and later calling it as `this.fetchImpl()` otherwise makes
    // this host object the receiver and fails before any request is sent.
    this.fetchImpl = fetchImpl.bind(globalThis);
    this.gateway = gatewayEndpoint(gatewayUrl);
  }

  request(request: ForeignRequest): Promise<ForeignResponse> {
    const run = this.queue.catch(() => undefined).then(() => this.perform(request));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async perform(request: ForeignRequest): Promise<ForeignResponse> {
    const url = assertAllowedUrl(request.url, this.manifest);
    if (request.gateway && (request.credential || (request.method ?? "GET") !== "GET" || request.body !== undefined)) {
      throw new ForeignLibraryError("permission-denied", "Gateway requests must be unauthenticated GET requests.");
    }
    const routedThroughGateway = request.gateway !== undefined && this.gateway !== undefined;
    const fetchUrl = routedThroughGateway ? gatewayRoute(this.gateway!, request.gateway!.route) : url;
    if (routedThroughGateway) fetchUrl.searchParams.set("url", url.toString());
    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.min(request.timeoutMs ?? 30_000, 120_000));
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const externalSignal = request.signal;
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      const interval = this.manifest.permissions.rateLimit?.minIntervalMs ?? 0;
      await wait(Math.max(0, this.nextRequestAt - Date.now()), controller.signal);
      this.nextRequestAt = Date.now() + interval;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers ?? {})) {
        if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
          throw new ForeignLibraryError("permission-denied", `Plugins cannot set the ${name} header.`);
        }
        headers.set(name, value);
      }
      if (request.credential) {
        const slot = this.manifest.permissions.credentials?.find((candidate) => candidate.id === request.credential?.slotId);
        if (!slot || !this.resolveCredential) throw new ForeignLibraryError("credential-required", "The required credential is unavailable.");
        const secret = await this.resolveCredential(this.manifest, slot);
        if (!secret) throw new ForeignLibraryError("credential-required", `${slot.label} is required.`);
        const placement = request.credential.placement;
        if (placement.kind === "bearer") headers.set("Authorization", `Bearer ${secret}`);
        else {
          if (FORBIDDEN_HEADERS.has(placement.headerName.toLowerCase())) {
            throw new ForeignLibraryError("permission-denied", `Credential injection cannot use the ${placement.headerName} header.`);
          }
          headers.set(placement.headerName, secret);
        }
      }
      let response: Response;
      try {
        response = await this.fetchImpl(fetchUrl, {
          method: request.method ?? "GET",
          headers,
          body: request.body,
          signal: controller.signal,
          credentials: "omit",
          // Credentialed requests cannot redirect, preventing a provider from
          // forwarding a custom credential header to another origin.
          redirect: request.credential || routedThroughGateway ? "error" : "follow",
        });
      } catch (error) {
        if (controller.signal.aborted) {
          if (timedOut) throw new ForeignLibraryError("network-unavailable", `The request to ${url.origin} timed out.`, true);
          throw abortError();
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new ForeignLibraryError("network-unavailable", `Could not reach ${url.origin}. (${detail})`, true);
      }
      const sourceUrl = routedThroughGateway
        ? response.headers.get(GATEWAY_SOURCE_HEADER) ?? url.toString()
        : response.url || url.toString();
      assertAllowedUrl(sourceUrl, this.manifest);
      const configuredLimit = this.manifest.permissions.maxResponseBytes ?? INGESTION_LIMITS.maxFileBytes;
      const limit = Math.min(request.maxResponseBytes ?? configuredLimit, configuredLimit, INGESTION_LIMITS.maxFileBytes);
      const body = await readLimited(response, limit);
      return {
        status: response.status,
        statusText: response.statusText,
        url: sourceUrl,
        headers: responseHeaders(response.headers),
        body,
      };
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }
}
