const APPVIEW = "https://public.api.bsky.app/xrpc";

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

/** Minimal cached client for public Bluesky AppView enrichment. */
export class PublicBlueskyEnricher implements JetstreamEnricher {
  private readonly actors = new Map<string, Promise<EnrichedActor | null>>();
  private readonly posts = new Map<string, Promise<EnrichedPost | null>>();

  actor(did: string): Promise<EnrichedActor | null> {
    const existing = this.actors.get(did);
    if (existing) return existing;
    const request = this.fetchActor(did);
    this.actors.set(did, request);
    return request;
  }

  post(uri: string): Promise<EnrichedPost | null> {
    const existing = this.posts.get(uri);
    if (existing) return existing;
    const request = this.fetchPost(uri);
    this.posts.set(uri, request);
    return request;
  }

  private async fetchActor(did: string): Promise<EnrichedActor | null> {
    try {
      const url = new URL(`${APPVIEW}/app.bsky.actor.getProfile`);
      url.searchParams.set("actor", did);
      const response = await fetch(url);
      if (!response.ok) return null;
      const value = object(await response.json());
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
      const response = await fetch(url);
      if (!response.ok) return null;
      const body = object(await response.json());
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
