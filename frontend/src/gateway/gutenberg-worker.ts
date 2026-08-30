const GUTENBERG_ORIGIN = "https://www.gutenberg.org";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://vbprojects.github.io",
  "http://localhost:1420",
  "http://127.0.0.1:1420",
];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 4;

export const GUTENBERG_GATEWAY_MAX_BYTES = 128 * 1024 * 1024;

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
    return handleGutenbergGateway(request, { allowedOrigins: allowedOrigins(env) });
  },
};
