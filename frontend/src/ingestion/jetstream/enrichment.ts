const APPVIEW = "https://public.api.bsky.app/xrpc";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_MAX_CACHE_ENTRIES = 256;

export interface EnrichedActor {
  did: string;
  handle: string;
}

export interface EnrichedPost {
  uri: string;
  author: EnrichedActor;
  text: string;
  langs?: string[];
}

export interface JetstreamEnricher {
  actor(did: string): Promise<EnrichedActor | null>;
  post(uri: string): Promise<EnrichedPost | null>;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface PublicBlueskyEnricherOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxCacheEntries?: number;
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Bluesky response exceeded the size limit");

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("Bluesky response exceeded the size limit");
    return JSON.parse(text);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Bluesky response exceeded the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Minimal cached client for public Bluesky AppView enrichment. */
export class PublicBlueskyEnricher implements JetstreamEnricher {
  private readonly actors = new Map<string, Promise<EnrichedActor | null>>();
  private readonly posts = new Map<string, Promise<EnrichedPost | null>>();
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxCacheEntries: number;

  constructor(options: PublicBlueskyEnricherOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxResponseBytes = Math.max(1, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    this.maxCacheEntries = Math.max(1, options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES);
  }

  actor(did: string): Promise<EnrichedActor | null> {
    if (did.length === 0 || did.length > 2_048) return Promise.resolve(null);
    const existing = this.actors.get(did);
    if (existing) {
      this.actors.delete(did);
      this.actors.set(did, existing);
      return existing;
    }
    const request = this.fetchActor(did);
    this.cache(this.actors, did, request);
    return request;
  }

  post(uri: string): Promise<EnrichedPost | null> {
    if (uri.length === 0 || uri.length > 2_048) return Promise.resolve(null);
    const existing = this.posts.get(uri);
    if (existing) {
      this.posts.delete(uri);
      this.posts.set(uri, existing);
      return existing;
    }
    const request = this.fetchPost(uri);
    this.cache(this.posts, uri, request);
    return request;
  }

  private cache<T>(cache: Map<string, Promise<T>>, key: string, value: Promise<T>): void {
    cache.set(key, value);
    while (cache.size > this.maxCacheEntries) cache.delete(cache.keys().next().value!);
  }

  private async request(url: URL): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) return null;
      return object(await boundedJson(response, this.maxResponseBytes));
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchActor(did: string): Promise<EnrichedActor | null> {
    try {
      const url = new URL(`${APPVIEW}/app.bsky.actor.getProfile`);
      url.searchParams.set("actor", did);
      const value = await this.request(url);
      return value && typeof value.did === "string" && typeof value.handle === "string"
        ? { did: value.did, handle: value.handle }
        : null;
    } catch {
      return null;
    }
  }

  private async fetchPost(uri: string): Promise<EnrichedPost | null> {
    try {
      const url = new URL(`${APPVIEW}/app.bsky.feed.getPosts`);
      url.searchParams.append("uris", uri);
      const body = await this.request(url);
      const post = Array.isArray(body?.posts) ? object(body.posts[0]) : null;
      const author = object(post?.author);
      const record = object(post?.record);
      if (!post || typeof post.uri !== "string" || !author || !record || typeof record.text !== "string") return null;
      if (typeof author.did !== "string" || typeof author.handle !== "string") return null;
      return {
        uri: post.uri,
        author: { did: author.did, handle: author.handle },
        text: record.text,
        ...(Array.isArray(record.langs)
          ? { langs: record.langs.filter((lang): lang is string => typeof lang === "string") }
          : {}),
      };
    } catch {
      return null;
    }
  }
}
