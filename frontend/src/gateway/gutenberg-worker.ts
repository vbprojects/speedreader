const GUTENBERG_ORIGIN = "https://www.gutenberg.org";
const ARXIV_EXPORT_ORIGIN = "https://export.arxiv.org";
const IFDB_ORIGIN = "https://ifdb.org";
const IFARCHIVE_ORIGIN = "https://ifarchive.org";
const IFARCHIVE_WWW_ORIGIN = "https://www.ifarchive.org";
const IFARCHIVE_SEARCH_URL = "https://search.ifarchive.org/search";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://vbprojects.github.io",
  "http://localhost:1420",
  "http://127.0.0.1:1420",
];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 4;

export const GUTENBERG_GATEWAY_MAX_BYTES = 128 * 1024 * 1024;
export const CATALOG_GATEWAY_MAX_BYTES = 2 * 1024 * 1024;
export const TWINE_GATEWAY_MAX_BYTES = 128 * 1024 * 1024;

export interface GutenbergGatewayEnv {
  ALLOWED_ORIGINS?: string;
}

export interface GutenbergGatewayOptions {
  allowedOrigins?: Iterable<string>;
  fetchImpl?: typeof fetch;
}

class GatewayError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function allowedOrigins(env?: GutenbergGatewayEnv): Set<string> {
  const configured = env?.ALLOWED_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean);
  return new Set(configured?.length ? configured : DEFAULT_ALLOWED_ORIGINS);
}

function corsHeaders(origin: string): Headers {
  return new Headers({
    "Access-Control-Allow-Headers": "Accept",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "Content-Length, Content-Type, X-Speedreader-Source-Url",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  });
}

function reply(status: number, message: string, origin?: string): Response {
  const headers = origin ? corsHeaders(origin) : new Headers();
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(message, { status, headers });
}

function initialBookId(url: URL): string {
  if (url.origin !== GUTENBERG_ORIGIN || url.username || url.password || url.search || url.hash) {
    throw new GatewayError(400, "Unsupported Gutenberg URL.");
  }
  const match = url.pathname.match(/^\/ebooks\/([1-9]\d*)\.epub(?:3)?\.(?:images|noimages)$/u);
  if (!match) throw new GatewayError(400, "Only Project Gutenberg EPUB acquisition URLs are supported.");
  return match[1];
}

function assertRedirect(url: URL, bookId: string): void {
  if (url.origin !== GUTENBERG_ORIGIN || url.username || url.password || url.search || url.hash) {
    throw new GatewayError(502, "Project Gutenberg redirected outside the permitted origin.");
  }
  const escapedBookId = bookId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const cachePath = new RegExp(`^/cache/epub/${escapedBookId}/[A-Za-z0-9._-]+\\.epub$`, "u");
  if (!cachePath.test(url.pathname)) {
    throw new GatewayError(502, "Project Gutenberg redirected to an unexpected file.");
  }
}

async function fetchEpub(url: URL, fetchImpl: typeof fetch): Promise<{ response: Response; sourceUrl: URL }> {
  const bookId = initialBookId(url);
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        headers: { Accept: "application/epub+zip" },
        redirect: "manual",
        cache: "no-store",
      });
    } catch {
      throw new GatewayError(502, "Project Gutenberg could not be reached.");
    }
    if (!REDIRECT_STATUSES.has(response.status)) return { response, sourceUrl: current };
    if (redirects === MAX_REDIRECTS) throw new GatewayError(502, "Project Gutenberg redirected too many times.");
    const location = response.headers.get("location");
    if (!location) throw new GatewayError(502, "Project Gutenberg returned an invalid redirect.");
    current = new URL(location, current);
    assertRedirect(current, bookId);
  }
  throw new GatewayError(502, "Project Gutenberg redirected too many times.");
}

function exactParameters(url: URL, names: string[]): boolean {
  const keys = [...url.searchParams.keys()];
  return keys.length === names.length && names.every((name) => keys.filter((key) => key === name).length === 1);
}

function catalogTarget(url: URL): { accept: string; label: string } {
  if (url.username || url.password || url.hash) throw new GatewayError(400, "Unsupported catalog URL.");
  if (url.origin === ARXIV_EXPORT_ORIGIN && url.pathname === "/api/query") {
    const allowed = new Set(["search_query", "id_list", "start", "max_results", "sortBy", "sortOrder"]);
    const keys = [...url.searchParams.keys()];
    if (keys.length === 0 || new Set(keys).size !== keys.length || keys.some((key) => !allowed.has(key))) {
      throw new GatewayError(400, "The arXiv query is invalid.");
    }
    const search = url.searchParams.get("search_query") ?? "";
    const ids = url.searchParams.get("id_list") ?? "";
    const start = Number(url.searchParams.get("start") ?? "0");
    const maximum = Number(url.searchParams.get("max_results") ?? "10");
    if ((!search && !ids) || search.length > 512 || ids.length > 256
      || !Number.isSafeInteger(start) || start < 0 || start > 10_000
      || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 25
      || (ids && !/^[A-Za-z0-9./-]+(?:,[A-Za-z0-9./-]+)*$/u.test(ids))) {
      throw new GatewayError(400, "The arXiv query is invalid.");
    }
    if (url.searchParams.has("sortBy") && !(["relevance", "lastUpdatedDate", "submittedDate"] as const).includes(url.searchParams.get("sortBy") as "relevance")) {
      throw new GatewayError(400, "The arXiv sort is invalid.");
    }
    if (url.searchParams.has("sortOrder") && !(["ascending", "descending"] as const).includes(url.searchParams.get("sortOrder") as "ascending")) {
      throw new GatewayError(400, "The arXiv sort is invalid.");
    }
    return { accept: "application/atom+xml", label: "arXiv" };
  }
  if (url.origin === IFDB_ORIGIN && url.pathname === "/search") {
    if (!exactParameters(url, ["json", "game", "searchfor"]) || url.searchParams.get("json") !== ""
      || url.searchParams.get("game") !== "") throw new GatewayError(400, "The IFDB search is invalid.");
    const search = url.searchParams.get("searchfor") ?? "";
    if (search.length < 1 || search.length > 512 || !/(?:^|\s)system:Twine(?:\s|$)/iu.test(search)) {
      throw new GatewayError(400, "Only IFDB Twine searches are supported.");
    }
    return { accept: "application/json", label: "IFDB" };
  }
  if (url.origin === IFDB_ORIGIN && url.pathname === "/viewgame") {
    if (!exactParameters(url, ["json", "id"]) || url.searchParams.get("json") !== "") {
      throw new GatewayError(400, "The IFDB detail request is invalid.");
    }
    const tuid = url.searchParams.get("id") ?? "";
    if (!/^[a-z0-9]{8,32}$/u.test(tuid)) throw new GatewayError(400, "The IFDB identifier is invalid.");
    return { accept: "application/json", label: "IFDB" };
  }
  throw new GatewayError(400, "Unsupported catalog URL.");
}

async function boundedCatalogBody(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CATALOG_GATEWAY_MAX_BYTES) throw new GatewayError(413, "The catalog response is too large.");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CATALOG_GATEWAY_MAX_BYTES) {
        await reader.cancel();
        throw new GatewayError(413, "The catalog response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body: Uint8Array<ArrayBuffer> = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function handleCatalogGateway(
  request: Request,
  options: GutenbergGatewayOptions = {},
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname !== "/v1/catalog") return reply(404, "Not found.");
  const origin = request.headers.get("origin") ?? "";
  const permittedOrigins = new Set(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  if (!permittedOrigins.has(origin)) return reply(403, "Origin is not permitted.");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "GET") return reply(405, "Only GET is supported.", origin);
  try {
    const rawTarget = requestUrl.searchParams.get("url");
    if (!rawTarget || requestUrl.searchParams.size !== 1) throw new GatewayError(400, "One catalog URL is required.");
    let target: URL;
    try {
      target = new URL(rawTarget);
    } catch {
      throw new GatewayError(400, "The catalog URL is invalid.");
    }
    const policy = catalogTarget(target);
    let response: Response;
    try {
      response = await (options.fetchImpl ?? globalThis.fetch.bind(globalThis))(target, {
        method: "GET",
        headers: { Accept: policy.accept, "User-Agent": "Speedreader Foreign Library/1.0" },
        redirect: "manual",
        cache: "no-store",
      });
    } catch {
      throw new GatewayError(502, `${policy.label} could not be reached.`);
    }
    if (response.status !== 200 || !response.body || REDIRECT_STATUSES.has(response.status)) {
      throw new GatewayError(502, `${policy.label} returned an invalid response.`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    const acceptedTypes = target.origin === IFDB_ORIGIN
      ? new Set(["application/json", "text/json"])
      : new Set(["application/atom+xml", "application/xml", "text/xml"]);
    if (!acceptedTypes.has(contentType)) throw new GatewayError(502, `${policy.label} returned an unexpected content type.`);
    const body = await boundedCatalogBody(response);
    const headers = corsHeaders(origin);
    headers.set(
      "Cache-Control",
      target.origin === IFDB_ORIGIN
        ? "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400"
        : "no-store",
    );
    headers.set("Content-Length", String(body.byteLength));
    headers.set("Content-Type", contentType);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Speedreader-Source-Url", target.toString());
    return new Response(body, { status: 200, headers });
  } catch (error) {
    if (error instanceof GatewayError) return reply(error.status, error.message, origin);
    return reply(500, "The gateway could not complete the request.", origin);
  }
}

interface IfdbTwineDownload {
  url?: unknown;
  isGame?: unknown;
  format?: unknown;
}

interface IfdbTwineDetail {
  ifdb?: {
    tuid?: unknown;
    primaryPlayOnlineUrl?: unknown;
    downloads?: { links?: unknown };
  };
}

interface TwineAcquisitionRequest {
  tuid: string;
  mode: "download" | "play" | "archive";
  offer?: number;
}

function twineAcquisitionRequest(url: URL): TwineAcquisitionRequest {
  if (url.origin !== IFDB_ORIGIN || url.pathname !== "/viewgame" || url.username || url.password || url.hash) {
    throw new GatewayError(400, "Unsupported Twine acquisition request.");
  }
  const mode = url.searchParams.get("speedreader");
  const tuid = url.searchParams.get("id") ?? "";
  if (!/^[a-z0-9]{8,32}$/u.test(tuid) || (mode !== "download" && mode !== "play" && mode !== "archive")) {
    throw new GatewayError(400, "The Twine acquisition request is invalid.");
  }
  if (mode === "download") {
    if (!exactParameters(url, ["speedreader", "id", "offer"])) throw new GatewayError(400, "The Twine download request is invalid.");
    const offer = Number(url.searchParams.get("offer"));
    if (!Number.isSafeInteger(offer) || offer < 0 || offer > 31) throw new GatewayError(400, "The Twine download offer is invalid.");
    return { tuid, mode, offer };
  }
  if (!exactParameters(url, ["speedreader", "id"])) throw new GatewayError(400, "The Twine acquisition request is invalid.");
  return { tuid, mode };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function boundedText(response: Response, limit: number, label: string): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new GatewayError(413, `${label} is too large.`);
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let result = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new GatewayError(413, `${label} is too large.`);
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(502, `${label} is not valid UTF-8.`);
  } finally {
    reader.releaseLock();
  }
}

async function fetchIfdbTwineDetail(tuid: string, fetchImpl: typeof fetch): Promise<IfdbTwineDetail> {
  const url = new URL("/viewgame", IFDB_ORIGIN);
  url.searchParams.set("json", "");
  url.searchParams.set("id", tuid);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "Speedreader Foreign Library/1.0" },
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    throw new GatewayError(502, "IFDB could not be reached.");
  }
  if (response.status !== 200 || REDIRECT_STATUSES.has(response.status)) throw new GatewayError(502, "IFDB returned an invalid detail response.");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "text/json") throw new GatewayError(502, "IFDB returned an unexpected detail type.");
  let detail: IfdbTwineDetail;
  try {
    detail = JSON.parse(await boundedText(response, CATALOG_GATEWAY_MAX_BYTES, "The IFDB detail response")) as IfdbTwineDetail;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(502, "IFDB returned invalid detail JSON.");
  }
  if (stringValue(detail.ifdb?.tuid) !== tuid) throw new GatewayError(502, "IFDB returned details for a different story.");
  return detail;
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/<[^>]*>/gu, "")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&")
    .replace(/&#(\d+);/gu, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([a-f0-9]+);/giu, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .trim();
}

async function findIfArchiveTwine(tuid: string, fetchImpl: typeof fetch): Promise<URL> {
  let response: Response;
  try {
    response = await fetchImpl(IFARCHIVE_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Speedreader Foreign Library/1.0",
      },
      body: new URLSearchParams({ searchstr: `tuid:${tuid}` }).toString(),
      redirect: "follow",
      cache: "no-store",
    });
  } catch {
    throw new GatewayError(502, "IF Archive search could not be reached.");
  }
  if (response.status !== 200 || new URL(response.url || IFARCHIVE_SEARCH_URL).origin !== new URL(IFARCHIVE_SEARCH_URL).origin) {
    throw new GatewayError(502, "IF Archive search returned an invalid response.");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "text/html") throw new GatewayError(502, "IF Archive search returned an unexpected response.");
  const html = await boundedText(response, CATALOG_GATEWAY_MAX_BYTES, "The IF Archive search response");
  const candidates: URL[] = [];
  const anchors = html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu);
  for (const match of anchors) {
    let indexUrl: URL;
    try {
      indexUrl = new URL(decodeHtmlText(match[1]), IFARCHIVE_ORIGIN);
    } catch {
      continue;
    }
    if (indexUrl.origin !== IFARCHIVE_ORIGIN && indexUrl.origin !== IFARCHIVE_WWW_ORIGIN) continue;
    const directory = indexUrl.pathname.match(/^\/indexes\/if-archive\/(games\/(?:twine|html)(?:\/[^#?]*)?)\/?$/u)?.[1];
    const filename = decodeHtmlText(match[2].match(/<b>([\s\S]*?)<\/b>/iu)?.[1] ?? "");
    if (!directory || !filename || /[\\/\0]/u.test(filename) || !/\.(?:html?|zip)$/iu.test(filename)) continue;
    candidates.push(new URL(`/if-archive/${directory.replace(/\/+$/u, "")}/${encodeURIComponent(filename)}`, IFARCHIVE_ORIGIN));
  }
  const preferred = candidates.find((candidate) => candidate.pathname.startsWith("/if-archive/games/twine/")) ?? candidates[0];
  if (!preferred) throw new GatewayError(404, "No preserved Twine release was found on IF Archive.");
  return preferred;
}

function assertSupportedTwineSource(url: URL): void {
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new GatewayError(422, "The selected Twine source is not supported for automatic import.");
  }
  if (url.origin === IFARCHIVE_ORIGIN || url.origin === IFARCHIVE_WWW_ORIGIN) {
    if (/^\/if-archive\/games\/(?:twine|html)(?:\/|$)/u.test(url.pathname) && /\.(?:html?|zip)$/iu.test(url.pathname)) return;
  } else if (url.hostname === "unbox.ifarchive.org" || url.hostname.endsWith(".unbox.ifarchive.org")) {
    return;
  }
  throw new GatewayError(422, "This release is hosted outside the supported IF Archive sources. Open its IFDB page instead.");
}

async function twineSourceFor(
  request: TwineAcquisitionRequest,
  detail: IfdbTwineDetail,
  fetchImpl: typeof fetch,
): Promise<URL> {
  if (request.mode === "archive") return findIfArchiveTwine(request.tuid, fetchImpl);
  if (request.mode === "play") {
    const raw = stringValue(detail.ifdb?.primaryPlayOnlineUrl);
    if (!raw) throw new GatewayError(404, "IFDB does not list a playable web release for this story.");
    let url: URL;
    try { url = new URL(raw); } catch { throw new GatewayError(502, "IFDB returned an invalid playable URL."); }
    assertSupportedTwineSource(url);
    return url;
  }
  const links = Array.isArray(detail.ifdb?.downloads?.links)
    ? detail.ifdb!.downloads!.links as IfdbTwineDownload[]
    : [];
  const link = links[request.offer!];
  const raw = stringValue(link?.url);
  if (!link || link.isGame !== true || !raw) {
    throw new GatewayError(404, "The selected IFDB release is no longer available for automatic import.");
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new GatewayError(502, "IFDB returned an invalid release URL."); }
  assertSupportedTwineSource(url);
  return url;
}

async function fetchTwineSource(url: URL, fetchImpl: typeof fetch): Promise<{ response: Response; sourceUrl: URL; contentType: string }> {
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    assertSupportedTwineSource(current);
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        headers: { Accept: "text/html, application/zip", "User-Agent": "Speedreader Foreign Library/1.0" },
        redirect: "manual",
        cache: "no-store",
      });
    } catch {
      throw new GatewayError(502, "The Twine release could not be reached.");
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      if (redirects === MAX_REDIRECTS) throw new GatewayError(502, "The Twine release redirected too many times.");
      const location = response.headers.get("location");
      if (!location) throw new GatewayError(502, "The Twine release returned an invalid redirect.");
      current = new URL(location, current);
      continue;
    }
    if (response.status !== 200 || !response.body) throw new GatewayError(502, `The Twine release returned ${response.status}.`);
    const contentLength = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(contentLength) || contentLength < 1) throw new GatewayError(502, "The Twine release did not provide a usable file size.");
    if (contentLength > TWINE_GATEWAY_MAX_BYTES) throw new GatewayError(413, "The Twine release exceeds Speedreader's size limit.");
    const upstreamType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    const zip = /\.zip$/iu.test(current.pathname) || upstreamType === "application/zip" || upstreamType === "application/x-zip-compressed";
    const html = /\.html?$/iu.test(current.pathname) || upstreamType === "text/html";
    if (!zip && !html) throw new GatewayError(502, "The Twine release returned an unsupported file type.");
    return { response, sourceUrl: current, contentType: zip ? "application/zip" : "text/html" };
  }
  throw new GatewayError(502, "The Twine release redirected too many times.");
}

export async function handleTwineGateway(
  request: Request,
  options: GutenbergGatewayOptions = {},
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname !== "/v1/twine") return reply(404, "Not found.");
  const origin = request.headers.get("origin") ?? "";
  const permittedOrigins = new Set(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  if (!permittedOrigins.has(origin)) return reply(403, "Origin is not permitted.");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "GET") return reply(405, "Only GET is supported.", origin);
  try {
    const rawTarget = requestUrl.searchParams.get("url");
    if (!rawTarget || requestUrl.searchParams.size !== 1) throw new GatewayError(400, "One Twine acquisition request is required.");
    let target: URL;
    try { target = new URL(rawTarget); } catch { throw new GatewayError(400, "The Twine acquisition URL is invalid."); }
    const acquisition = twineAcquisitionRequest(target);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const detail = await fetchIfdbTwineDetail(acquisition.tuid, fetchImpl);
    const source = await twineSourceFor(acquisition, detail, fetchImpl);
    const downloaded = await fetchTwineSource(source, fetchImpl);
    const contentLength = downloaded.response.headers.get("content-length")!;
    const headers = corsHeaders(origin);
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Length", contentLength);
    headers.set("Content-Type", downloaded.contentType);
    headers.set("Content-Disposition", "attachment");
    headers.set("X-Content-Type-Options", "nosniff");
    // The PWA validates this header against the plugin's declared IFDB origin.
    // The resolved external URL is intentionally not reflected to callers.
    headers.set("X-Speedreader-Source-Url", target.toString());
    return new Response(downloaded.response.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof GatewayError) return reply(error.status, error.message, origin);
    return reply(500, "The gateway could not complete the Twine import.", origin);
  }
}

export async function handleGutenbergGateway(
  request: Request,
  options: GutenbergGatewayOptions = {},
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname === "/health" && request.method === "GET") {
    return new Response("ok", { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (requestUrl.pathname !== "/v1/gutenberg") return reply(404, "Not found.");

  const origin = request.headers.get("origin") ?? "";
  const permittedOrigins = new Set(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  if (!permittedOrigins.has(origin)) return reply(403, "Origin is not permitted.");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "GET") return reply(405, "Only GET is supported.", origin);

  try {
    const rawTarget = requestUrl.searchParams.get("url");
    if (!rawTarget || requestUrl.searchParams.size !== 1) throw new GatewayError(400, "One Gutenberg URL is required.");
    let target: URL;
    try {
      target = new URL(rawTarget);
    } catch {
      throw new GatewayError(400, "The Gutenberg URL is invalid.");
    }
    initialBookId(target);
    const { response, sourceUrl } = await fetchEpub(target, options.fetchImpl ?? globalThis.fetch.bind(globalThis));
    if (response.status !== 200 || !response.body) throw new GatewayError(502, `Project Gutenberg returned ${response.status}.`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/epub+zip") throw new GatewayError(502, "Project Gutenberg returned an unexpected file type.");
    const contentLength = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
      throw new GatewayError(502, "Project Gutenberg did not provide a usable file size.");
    }
    if (contentLength > GUTENBERG_GATEWAY_MAX_BYTES) throw new GatewayError(413, "The EPUB exceeds Speedreader's size limit.");

    const headers = corsHeaders(origin);
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Length", String(contentLength));
    headers.set("Content-Type", "application/epub+zip");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Speedreader-Source-Url", sourceUrl.toString());
    for (const name of ["etag", "last-modified"] as const) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(response.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof GatewayError) return reply(error.status, error.message, origin);
    return reply(500, "The gateway could not complete the request.", origin);
  }
}

export default {
  fetch(request: Request, env: GutenbergGatewayEnv): Promise<Response> {
    const options = { allowedOrigins: allowedOrigins(env) };
    const pathname = new URL(request.url).pathname;
    if (pathname === "/v1/catalog") return handleCatalogGateway(request, options);
    if (pathname === "/v1/twine") return handleTwineGateway(request, options);
    return handleGutenbergGateway(request, options);
  },
};
