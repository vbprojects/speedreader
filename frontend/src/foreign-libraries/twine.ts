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
const IFARCHIVE_HOSTS = new Set(["ifarchive.org", "www.ifarchive.org"]);
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const SEARCH_CACHE_LIMIT = 24;
const DETAIL_CACHE_LIMIT = 64;
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

interface IfdbDownloadLink {
  url?: unknown;
  playOnlineUrl?: unknown;
  title?: unknown;
  desc?: unknown;
  isGame?: unknown;
  format?: unknown;
}

interface IfdbGameDetail {
  identification?: { format?: unknown };
  bibliographic?: {
    title?: unknown;
    author?: unknown;
    firstpublished?: unknown;
  };
  ifdb?: {
    tuid?: unknown;
    pageversion?: unknown;
    primaryPlayOnlineUrl?: unknown;
    downloads?: { links?: unknown };
  };
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

function detailUrl(itemId: string): string {
  return `${IFDB_ORIGIN}/viewgame?json=&id=${encodeURIComponent(itemId)}`;
}

function acquisitionUrl(itemId: string, mode: "download" | "play" | "archive", offer?: number): string {
  const url = new URL("/viewgame", IFDB_ORIGIN);
  url.searchParams.set("speedreader", mode);
  url.searchParams.set("id", itemId);
  if (offer !== undefined) url.searchParams.set("offer", String(offer));
  return url.toString();
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

function sourceOffer(): ForeignItem["offers"] {
  return [{
    id: "ifdb-source-page",
    label: "Choose a release on IFDB",
    outputType: "html",
    importKind: "download",
    mediaType: "text/html",
    extension: "html",
    priority: 0,
    risk: "executable-content",
  }];
}

function supportedAutomaticSource(value: unknown): boolean {
  const raw = string(value);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (IFARCHIVE_HOSTS.has(url.hostname)) {
      return /^\/if-archive\/games\/(?:twine|html)(?:\/|$)/u.test(url.pathname)
        && /\.(?:html?|zip)$/iu.test(url.pathname);
    }
    return url.hostname === "unbox.ifarchive.org" || url.hostname.endsWith(".unbox.ifarchive.org");
  } catch {
    return false;
  }
}

function downloadableFile(link: IfdbDownloadLink): { extension: "html" | "zip"; mediaType: string } | null {
  const raw = string(link.url);
  if (!raw || !supportedAutomaticSource(raw) || link.isGame !== true) return null;
  const title = string(link.title) ?? "";
  const pathname = new URL(raw).pathname;
  if (/\.zip$/iu.test(pathname) || /\.zip$/iu.test(title)) return { extension: "zip", mediaType: "application/zip" };
  if (/\.html?$/iu.test(pathname) || /\.html?$/iu.test(title)
    || /(?:html|twine)/iu.test(string(link.format) ?? "")) return { extension: "html", mediaType: "text/html" };
  return null;
}

function detailOffers(detail: IfdbGameDetail): ForeignItem["offers"] {
  const links = Array.isArray(detail.ifdb?.downloads?.links)
    ? detail.ifdb!.downloads!.links as IfdbDownloadLink[]
    : [];
  const offers: ForeignItem["offers"] = [];
  links.slice(0, 32).forEach((link, index) => {
    const file = downloadableFile(link);
    if (!file) return;
    const title = string(link.title);
    offers.push({
      id: `ifdb-download-${index}`,
      label: title ? `Import ${title.slice(0, 160)}` : `Import ${file.extension.toUpperCase()} release`,
      outputType: "sugarcube",
      importKind: "download",
      mediaType: file.mediaType,
      extension: file.extension,
      priority: 30 - index,
      risk: "executable-content",
    });
  });
  const playUrl = string(detail.ifdb?.primaryPlayOnlineUrl);
  const represented = links.some((link) => string(link.url) === playUrl || string(link.playOnlineUrl) === playUrl);
  if (playUrl && supportedAutomaticSource(playUrl) && !represented) {
    offers.push({
      id: "ifdb-play-online",
      label: "Import playable HTML",
      outputType: "sugarcube",
      importKind: "download",
      mediaType: "text/html",
      extension: "html",
      priority: 20,
      risk: "executable-content",
    });
  }
  if (offers.length === 0) {
    offers.push({
      id: "ifarchive-fallback",
      label: "Find a preserved copy on IF Archive",
      outputType: "sugarcube",
      importKind: "download",
      extension: "zip",
      priority: 10,
      risk: "executable-content",
    });
  }
  return [...offers, ...sourceOffer()];
}

function featuredItem(game: FeaturedTwineGame): ForeignItem {
  return {
    ref: { libraryId: TWINE_LIBRARY_ID, itemId: game.itemId },
    kind: "application",
    title: game.title,
    ...(game.authors ? { authors: game.authors } : {}),
    ...(game.publishedAt ? { publishedAt: game.publishedAt } : {}),
    canonicalUrl: listingUrl(game.itemId),
    offers: sourceOffer(),
  };
}

export class TwineForeignLibrary implements ForeignLibraryPlugin {
  readonly manifest: ForeignLibraryManifest = {
    apiVersion: FOREIGN_LIBRARY_API,
    id: TWINE_LIBRARY_ID,
    version: "1.2.0",
    name: "Twine on IFDB",
    description: "Search IFDB, import supported IF Archive HTML or ZIP releases, or visit the original listing.",
    homepage: IFDB_ORIGIN,
    capabilities: ["catalog.search", "catalog.browse", "item.resolve", "item.acquire"],
    outputs: [
      { type: "html", label: "HTML", delivery: ["download"], mediaTypes: ["text/html"], extensions: ["html", "htm"] },
      {
        type: "sugarcube",
        label: "SugarCube",
        delivery: ["download"],
        mediaTypes: ["text/html", "application/zip", "application/x-zip-compressed"],
        extensions: ["html", "htm", "zip"],
      },
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
    const detailCache = new Map<string, Promise<ForeignItem>>();
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
      const base = cachedItems.get(ref.itemId) ?? {
        ref: { libraryId: TWINE_LIBRARY_ID, itemId: ref.itemId },
        kind: "application",
        title: `IFDB story ${ref.itemId}`,
        canonicalUrl: listingUrl(ref.itemId),
        offers: sourceOffer(),
      };
      cachedItems.set(ref.itemId, base);
      const cached = detailCache.get(ref.itemId);
      if (cached) return cached;
      const pending = (async (): Promise<ForeignItem> => {
        try {
          const detail = await fetchJson(detailUrl(ref.itemId)) as IfdbGameDetail;
          if (!detail.ifdb || string(detail.ifdb.tuid) !== ref.itemId) {
            throw new ForeignLibraryError("invalid-response", "IFDB returned details for a different story.");
          }
          const pageVersion = detail.ifdb.pageversion;
          const revision = typeof pageVersion === "number" && Number.isSafeInteger(pageVersion)
            ? String(pageVersion)
            : string(pageVersion);
          const resolved: ForeignItem = {
            ...base,
            ref: { ...base.ref, ...(revision ? { revision } : {}) },
            title: string(detail.bibliographic?.title) ?? base.title,
            ...(authors(detail.bibliographic?.author) ? { authors: authors(detail.bibliographic?.author) } : {}),
            ...(string(detail.bibliographic?.firstpublished) ? { publishedAt: string(detail.bibliographic?.firstpublished) } : {}),
            offers: detailOffers(detail),
          };
          cachedItems.set(ref.itemId, resolved);
          return resolved;
        } catch (error) {
          if (error instanceof ForeignLibraryError && IFDB_AVAILABILITY_ERRORS.has(error.code)) {
            detailCache.delete(ref.itemId);
            return base;
          }
          detailCache.delete(ref.itemId);
          throw error;
        }
      })();
      if (detailCache.size >= DETAIL_CACHE_LIMIT) detailCache.delete(detailCache.keys().next().value ?? "");
      detailCache.set(ref.itemId, pending);
      return pending;
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
          offers: sourceOffer(),
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
        const item = await resolve(ref);
        const offer = item.offers.find((candidate) => candidate.id === selectedOfferId);
        if (!offer) throw new ForeignLibraryError("not-found", "This IFDB acquisition option is unavailable.");
        const provenance = {
          libraryId: TWINE_LIBRARY_ID,
          itemId: ref.itemId,
          revision: item.ref.revision,
          canonicalUrl: item.canonicalUrl,
        };
        if (selectedOfferId === "ifdb-source-page") {
          return {
            kind: "download",
            acquisition: "manual",
            manualAction: "source-page",
            request: { url: listingUrl(ref.itemId) },
            file: { name: `${slug(item.title)}-${ref.itemId}.html`, extension: "html", mimeType: "text/html" },
            provenance,
          };
        }
        let mode: "download" | "play" | "archive";
        let offerIndex: number | undefined;
        const match = selectedOfferId.match(/^ifdb-download-(\d+)$/u);
        if (match) {
          mode = "download";
          offerIndex = Number(match[1]);
        } else if (selectedOfferId === "ifdb-play-online") {
          mode = "play";
        } else if (selectedOfferId === "ifarchive-fallback") {
          mode = "archive";
        } else {
          throw new ForeignLibraryError("not-found", "This IFDB acquisition option is unavailable.");
        }
        const extension = offer.extension === "zip" ? "zip" : "html";
        return {
          kind: "download",
          acquisition: "host",
          request: {
            url: acquisitionUrl(ref.itemId, mode, offerIndex),
            gateway: { route: "twine" },
            timeoutMs: 120_000,
            maxResponseBytes: INGESTION_LIMITS.maxFileBytes,
            headers: { Accept: "text/html, application/zip" },
          },
          file: {
            name: `${slug(item.title)}-${ref.itemId}.${extension}`,
            extension,
            ...(offer.mediaType ? { mimeType: offer.mediaType } : {}),
          },
          provenance,
        };
      },
      dispose: () => { cachedItems.clear(); searchCache.clear(); detailCache.clear(); },
    };
  }
}
