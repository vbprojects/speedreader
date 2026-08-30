import { INGESTION_LIMITS } from "../ingestion/limits";
import {
  FOREIGN_LIBRARY_API,
  ForeignLibraryError,
  type ForeignBrowseRequest,
  type ForeignDownloadPlan,
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

const IFDB_ORIGIN = "https://ifdb.org";
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const SEARCH_CACHE_LIMIT = 24;
const IFDB_AVAILABILITY_ERRORS = new Set([
  "network-unavailable",
  "cors-blocked",
  "rate-limited",
  "acquisition-failed",
]);

export const TWINE_LIBRARY_ID = "org.ifdb.twine";

interface IfdbSearchGame {
  tuid?: unknown;
  title?: unknown;
  author?: unknown;
  devsys?: unknown;
  published?: { machine?: unknown };
  coverArtLink?: unknown;
}

interface FeaturedTwineGame {
  itemId: string;
  title: string;
  authors?: string[];
  publishedAt?: string;
}

// A small stable shelf makes opening the library useful without crawling IFDB.
// Search remains live and user-driven through IFDB's documented JSON API.
const FEATURED_TWINE_GAMES: FeaturedTwineGame[] = [
  { itemId: "hslgyznv9n2hou7k", title: "Open Sorcery", authors: ["Abigail Corfman"], publishedAt: "2016" },
  { itemId: "4iny0hu41p1wmpkf", title: "The Good Ghost", publishedAt: "2022" },
  { itemId: "qle7qs6w25vqb5dg", title: "The Writer Will Do Something", authors: ["Tom Bissell", "Matthew S. Burns"], publishedAt: "2015" },
  { itemId: "ny55g5epm7eldub5", title: "Contrition", authors: ["Porpentine"], publishedAt: "2014" },
  { itemId: "h4razidaaqzttraz", title: "Ruiness", authors: ["Porpentine Charity Heartscape"], publishedAt: "2015" },
  { itemId: "ny6bsy6olm5b9y3i", title: "The Fairy Woods", publishedAt: "2016" },
];

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "").slice(0, 96) || "twine-story";
}

function authors(value: unknown): string[] | undefined {
  const author = string(value);
  if (!author) return undefined;
  return [author];
}

function listingUrl(itemId: string): string {
  return `${IFDB_ORIGIN}/viewgame?id=${encodeURIComponent(itemId)}`;
}

function ifdbCoverUrl(value: unknown): string | undefined {
  const raw = string(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.origin !== IFDB_ORIGIN || url.username || url.password || url.pathname !== "/coverart") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function itemOffer(): ForeignItem["offers"] {
  return [{
    id: "ifdb-source-page",
    label: "Get HTML from IFDB",
    outputType: "html",
    importKind: "download",
    mediaType: "text/html",
    extension: "html",
    priority: 0,
    risk: "executable-content",
  }];
}

function featuredItem(game: FeaturedTwineGame): ForeignItem {
  return {
    ref: { libraryId: TWINE_LIBRARY_ID, itemId: game.itemId },
    kind: "application",
    title: game.title,
    ...(game.authors ? { authors: game.authors } : {}),
    ...(game.publishedAt ? { publishedAt: game.publishedAt } : {}),
    canonicalUrl: listingUrl(game.itemId),
    offers: itemOffer(),
  };
}

export class TwineForeignLibrary implements ForeignLibraryPlugin {
  readonly manifest: ForeignLibraryManifest = {
    apiVersion: FOREIGN_LIBRARY_API,
    id: TWINE_LIBRARY_ID,
    version: "1.1.0",
    name: "Twine on IFDB",
    description: "Search IFDB's official Twine catalog, then visit the original listing to choose and download an HTML release.",
    homepage: IFDB_ORIGIN,
    capabilities: ["catalog.search", "catalog.browse", "item.resolve", "item.acquire"],
    outputs: [
      { type: "html", label: "HTML", delivery: ["download"], mediaTypes: ["text/html"], extensions: ["html", "htm"] },
      { type: "sugarcube", label: "SugarCube", delivery: ["download"], mediaTypes: ["text/html"], extensions: ["html", "htm"] },
    ],
    permissions: {
      networkOrigins: [IFDB_ORIGIN],
      manualDownloadOrigins: [IFDB_ORIGIN],
      rateLimit: { maxConcurrent: 1, minIntervalMs: 1_000 },
      maxResponseBytes: INGESTION_LIMITS.maxFileBytes,
    },
  };

  async open(host: ForeignLibraryHost): Promise<ForeignLibrarySession> {
    const cachedItems = new Map<string, ForeignItem>();
    const searchCache = new Map<string, ForeignItem[]>();
    for (const game of FEATURED_TWINE_GAMES) cachedItems.set(game.itemId, featuredItem(game));

    const fetchJson = async (url: string, signal?: AbortSignal): Promise<Json> => {
      const response = await host.request({
        url,
        signal,
        gateway: { route: "catalog" },
        timeoutMs: 30_000,
        maxResponseBytes: MAX_CATALOG_BYTES,
        headers: { Accept: "application/json" },
      });
      if (response.status !== 200) throw new ForeignLibraryError("acquisition-failed", `IFDB returned ${response.status}.`, response.status >= 500);
      try {
        return JSON.parse(new TextDecoder().decode(response.body)) as Json;
      } catch {
        throw new ForeignLibraryError("invalid-response", "IFDB returned invalid JSON.");
      }
    };

    const resolve = async (ref: ForeignItemRef): Promise<ForeignItem> => {
      if (ref.libraryId !== TWINE_LIBRARY_ID || !/^[a-z0-9]{8,32}$/u.test(ref.itemId)) {
        throw new ForeignLibraryError("invalid-request", "The story has an invalid IFDB identifier.");
      }
      const existing = cachedItems.get(ref.itemId);
      if (existing) return existing;
      const item: ForeignItem = {
        ref: { libraryId: TWINE_LIBRARY_ID, itemId: ref.itemId },
        kind: "application",
        title: `IFDB story ${ref.itemId}`,
        canonicalUrl: listingUrl(ref.itemId),
        offers: itemOffer(),
      };
      cachedItems.set(ref.itemId, item);
      return item;
    };

    const pageForSearch = async (searchFor: string, pageSize: number, signal?: AbortSignal): Promise<ForeignPage<ForeignItem>> => {
      const limit = Math.min(pageSize, 25);
      const cacheKey = searchFor.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
      const cachedResults = searchCache.get(cacheKey);
      if (cachedResults) return { items: cachedResults.slice(0, limit) };
      const response = await fetchJson(`${IFDB_ORIGIN}/search?json=&game=&searchfor=${encodeURIComponent(searchFor)}`, signal) as { games?: unknown };
      const games = Array.isArray(response.games) ? response.games as IfdbSearchGame[] : [];
      const items = games.slice(0, 25).flatMap((game) => {
        const itemId = string(game.tuid);
        const title = string(game.title);
        if (!itemId || !/^[a-z0-9]{8,32}$/u.test(itemId) || !title || string(game.devsys)?.toLowerCase() !== "twine") return [];
        const coverUrl = ifdbCoverUrl(game.coverArtLink);
        const item: ForeignItem = {
          ref: { libraryId: TWINE_LIBRARY_ID, itemId },
          kind: "application",
          title,
          ...(authors(game.author) ? { authors: authors(game.author) } : {}),
          ...(string(game.published?.machine) ? { publishedAt: string(game.published?.machine) } : {}),
          canonicalUrl: listingUrl(itemId),
          ...(coverUrl ? { coverUrl } : {}),
          offers: itemOffer(),
        };
        cachedItems.set(itemId, item);
        return [item];
      });
      if (searchCache.size >= SEARCH_CACHE_LIMIT) searchCache.delete(searchCache.keys().next().value ?? "");
      searchCache.set(cacheKey, items);
      return { items: items.slice(0, limit) };
    };

    return {
      async search(request: ForeignSearchRequest): Promise<ForeignPage<ForeignItem>> {
        const query = request.query.trim();
        if (!query) throw new ForeignLibraryError("invalid-request", "Enter a Twine title or author to search IFDB.");
        try {
          return await pageForSearch(`${query} system:Twine`, request.pageSize ?? 25, request.signal);
        } catch (error) {
          if (error instanceof ForeignLibraryError && IFDB_AVAILABILITY_ERRORS.has(error.code)) {
            throw new ForeignLibraryError(
              error.code,
              "Live IFDB search is unavailable. Use Visit source to search IFDB directly.",
              error.retryable,
              error.retryAfterMs,
            );
          }
          throw error;
        }
      },
      async browse(request: ForeignBrowseRequest): Promise<ForeignPage<ForeignItem>> {
        return { items: FEATURED_TWINE_GAMES.slice(0, Math.min(request.pageSize ?? 24, FEATURED_TWINE_GAMES.length)).map(featuredItem) };
      },
      resolve,
      async planImport(ref, selectedOfferId): Promise<ForeignDownloadPlan> {
        if (selectedOfferId !== "ifdb-source-page") throw new ForeignLibraryError("not-found", "This IFDB acquisition option is unavailable.");
        const item = await resolve(ref);
        return {
          kind: "download",
          acquisition: "manual",
          manualAction: "source-page",
          request: { url: listingUrl(ref.itemId) },
          file: { name: `${slug(item.title)}-${ref.itemId}.html`, extension: "html", mimeType: "text/html" },
          provenance: { libraryId: TWINE_LIBRARY_ID, itemId: ref.itemId, revision: item.ref.revision, canonicalUrl: item.canonicalUrl },
        };
      },
      dispose: () => { cachedItems.clear(); searchCache.clear(); },
    };
  }
}
