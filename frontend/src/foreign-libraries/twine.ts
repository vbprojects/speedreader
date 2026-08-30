import { INGESTION_LIMITS } from "../ingestion/limits";
import {
  FOREIGN_LIBRARY_API,
  ForeignLibraryError,
  type ForeignDownloadPlan,
  type ForeignBrowseRequest,
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
const MANUAL_ORIGINS = [IFDB_ORIGIN, "https://ifarchive.org", "https://www.ifarchive.org"];
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

export const TWINE_LIBRARY_ID = "org.ifdb.twine";

type HtmlParser = (source: string) => Document;

interface IfdbSearchGame {
  tuid?: unknown;
  title?: unknown;
  author?: unknown;
  devsys?: unknown;
  link?: unknown;
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
  bibliographic?: {
    title?: unknown;
    author?: unknown;
    language?: unknown;
    firstpublished?: unknown;
    description?: unknown;
  };
  ifdb?: {
    tuid?: unknown;
    link?: unknown;
    pageversion?: unknown;
    coverart?: { url?: unknown };
    downloads?: { links?: unknown };
    tags?: unknown;
  };
}

interface TwineAcquisition {
  offerId: string;
  url: string;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "").slice(0, 96) || "twine-story";
}

function plainText(value: string | undefined, parseHtml: HtmlParser): string | undefined {
  if (!value) return undefined;
  const text = parseHtml(value).body?.textContent?.replace(/\s+/gu, " ").trim();
  return text || undefined;
}

function authors(value: unknown): string[] | undefined {
  const author = string(value);
  if (!author) return undefined;
  return [author];
}

function directHtmlUrl(value: unknown): string | null {
  const raw = string(value);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!MANUAL_ORIGINS.includes(url.origin) || url.username || url.password || !/\.html?$/iu.test(url.pathname)) return null;
  return url.toString();
}

function offerId(index: number): string {
  return `twine-html-${index + 1}`;
}

export class TwineForeignLibrary implements ForeignLibraryPlugin {
  readonly manifest: ForeignLibraryManifest = {
    apiVersion: FOREIGN_LIBRARY_API,
    id: TWINE_LIBRARY_ID,
    version: "1.0.0",
    name: "Twine on IFDB",
    description: "Search Twine stories cataloged by the Interactive Fiction Database and import direct HTML releases from IFDB or IF Archive.",
    homepage: IFDB_ORIGIN,
    capabilities: ["catalog.search", "catalog.browse", "item.resolve", "item.acquire"],
    outputs: [
      { type: "html", label: "HTML", delivery: ["download"], mediaTypes: ["text/html"], extensions: ["html", "htm"] },
      { type: "sugarcube", label: "SugarCube", delivery: ["download"], mediaTypes: ["text/html"], extensions: ["html", "htm"] },
    ],
    permissions: {
      networkOrigins: [IFDB_ORIGIN],
      manualDownloadOrigins: MANUAL_ORIGINS,
      rateLimit: { maxConcurrent: 1, minIntervalMs: 500 },
      maxResponseBytes: INGESTION_LIMITS.maxFileBytes,
    },
  };

  constructor(private readonly parseHtml: HtmlParser = (source) => new DOMParser().parseFromString(source, "text/html")) {}

  async open(host: ForeignLibraryHost): Promise<ForeignLibrarySession> {
    const cached = new Map<string, ForeignItem>();
    const acquisitions = new Map<string, TwineAcquisition[]>();

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
      const existing = cached.get(ref.itemId);
      if (existing && acquisitions.has(ref.itemId)) return existing;
      const detail = await fetchJson(`${IFDB_ORIGIN}/viewgame?json=&id=${encodeURIComponent(ref.itemId)}`) as IfdbGameDetail;
      const bibliography = detail.bibliographic ?? {};
      const ifdb = detail.ifdb ?? {};
      const title = string(bibliography.title) ?? existing?.title ?? `IFDB story ${ref.itemId}`;
      const links = Array.isArray(ifdb.downloads?.links) ? ifdb.downloads.links as IfdbDownloadLink[] : [];
      const seen = new Set<string>();
      const candidates: Array<{ url: string; label: string }> = [];
      for (const link of links) {
        if (link.isGame === false) continue;
        for (const possible of [link.url, link.playOnlineUrl]) {
          const url = directHtmlUrl(possible);
          if (!url || seen.has(url)) continue;
          seen.add(url);
          candidates.push({ url, label: string(link.title) ?? "Twine HTML" });
        }
      }
      const planned = candidates.map((candidate, index) => ({ offerId: offerId(index), url: candidate.url }));
      acquisitions.set(ref.itemId, planned);
      const tags = Array.isArray(ifdb.tags)
        ? ifdb.tags.map((tag) => string((tag as { name?: unknown })?.name)).filter((tag): tag is string => Boolean(tag))
        : undefined;
      const item: ForeignItem = {
        ref: { libraryId: TWINE_LIBRARY_ID, itemId: ref.itemId, ...(ifdb.pageversion !== undefined ? { revision: String(ifdb.pageversion) } : {}) },
        kind: "application",
        title,
        ...(authors(bibliography.author) ? { authors: authors(bibliography.author) } : {}),
        ...(plainText(string(bibliography.description), this.parseHtml) ? { summary: plainText(string(bibliography.description), this.parseHtml) } : {}),
        ...(string(bibliography.language) ? { language: string(bibliography.language) } : {}),
        ...(string(bibliography.firstpublished) ? { publishedAt: string(bibliography.firstpublished) } : {}),
        canonicalUrl: string(ifdb.link) ?? `${IFDB_ORIGIN}/viewgame?id=${ref.itemId}`,
        ...(string(ifdb.coverart?.url) ? { coverUrl: string(ifdb.coverart?.url) } : {}),
        ...(tags?.length ? { subjects: tags } : {}),
        offers: candidates.map((candidate, index) => ({
          id: offerId(index),
          label: candidate.label,
          outputType: "html",
          importKind: "download",
          mediaType: "text/html",
          extension: "html",
          priority: index,
          risk: "executable-content",
        })),
      };
      cached.set(ref.itemId, item);
      return item;
    };

    const pageForSearch = async (searchFor: string, pageSize: number, signal?: AbortSignal): Promise<ForeignPage<ForeignItem>> => {
      const response = await fetchJson(`${IFDB_ORIGIN}/search?json=&game=&searchfor=${encodeURIComponent(searchFor)}`, signal) as { games?: unknown };
      const games = Array.isArray(response.games) ? response.games as IfdbSearchGame[] : [];
      const items = games.slice(0, Math.min(pageSize, 25)).flatMap((game) => {
        const itemId = string(game.tuid);
        const title = string(game.title);
        if (!itemId || !/^[a-z0-9]{8,32}$/u.test(itemId) || !title || string(game.devsys)?.toLowerCase() !== "twine") return [];
        const item: ForeignItem = {
          ref: { libraryId: TWINE_LIBRARY_ID, itemId },
          kind: "application",
          title,
          ...(authors(game.author) ? { authors: authors(game.author) } : {}),
          ...(string(game.published?.machine) ? { publishedAt: string(game.published?.machine) } : {}),
          canonicalUrl: string(game.link) ?? `${IFDB_ORIGIN}/viewgame?id=${itemId}`,
          ...(string(game.coverArtLink) ? { coverUrl: string(game.coverArtLink) } : {}),
          offers: [],
        };
        cached.set(itemId, item);
        return [item];
      });
      return { items };
    };

    const search = async (request: ForeignSearchRequest): Promise<ForeignPage<ForeignItem>> => {
      const query = request.query.trim();
      if (!query) throw new ForeignLibraryError("invalid-request", "Enter a Twine title or author to search IFDB.");
      return pageForSearch(`${query} system:Twine`, request.pageSize ?? 25, request.signal);
    };

    const browse = (request: ForeignBrowseRequest): Promise<ForeignPage<ForeignItem>> =>
      pageForSearch("system:Twine", request.pageSize ?? 24, request.signal);

    return {
      search,
      browse,
      resolve,
      async planImport(ref, selectedOfferId): Promise<ForeignDownloadPlan> {
        const item = await resolve(ref);
        const acquisition = acquisitions.get(ref.itemId)?.find((candidate) => candidate.offerId === selectedOfferId);
        if (!acquisition) throw new ForeignLibraryError("not-found", "This IFDB listing has no supported direct HTML release.");
        return {
          kind: "download",
          acquisition: "manual",
          request: { url: acquisition.url },
          file: { name: `${slug(item.title)}-${ref.itemId}.html`, extension: "html", mimeType: "text/html" },
          provenance: { libraryId: TWINE_LIBRARY_ID, itemId: ref.itemId, revision: item.ref.revision, canonicalUrl: item.canonicalUrl },
        };
      },
      dispose: () => { cached.clear(); acquisitions.clear(); },
    };
  }
}
