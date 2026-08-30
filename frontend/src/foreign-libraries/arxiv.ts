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
} from "./types";

const EXPORT_ORIGIN = "https://export.arxiv.org";
const ARXIV_ORIGIN = "https://arxiv.org";
const ATOM_NS = "http://www.w3.org/2005/Atom";
const OPENSEARCH_NS = "http://a9.com/-/spec/opensearch/1.1/";
const ARXIV_NS = "http://arxiv.org/schemas/atom";
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

export const ARXIV_LIBRARY_ID = "org.arxiv.catalog";

type XmlParser = (source: string) => Document;

function childText(parent: Element, namespace: string, name: string): string | undefined {
  const value = parent.getElementsByTagNameNS(namespace, name)[0]?.textContent?.replace(/\s+/gu, " ").trim();
  return value || undefined;
}

function arxivId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const id = url.pathname.match(/^\/abs\/(.+)$/u)?.[1];
  return id && /^[A-Za-z0-9./-]+$/u.test(id) ? id : null;
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "").slice(0, 96) || "arxiv-paper";
}

function safeQuery(value: string): string {
  return value.replace(/["\\]/gu, " ").replace(/\s+/gu, " ").trim();
}

function parseEntry(entry: Element): ForeignItem | null {
  const id = arxivId(childText(entry, ATOM_NS, "id") ?? "");
  const title = childText(entry, ATOM_NS, "title");
  if (!id || !title) return null;
  const authors = [...entry.getElementsByTagNameNS(ATOM_NS, "author")]
    .map((author) => childText(author, ATOM_NS, "name"))
    .filter((author): author is string => Boolean(author));
  const subjects = [...entry.getElementsByTagNameNS(ATOM_NS, "category")]
    .map((category) => category.getAttribute("term")?.trim())
    .filter((subject): subject is string => Boolean(subject));
  const licenseUrl = childText(entry, ARXIV_NS, "license");
  return {
    ref: { libraryId: ARXIV_LIBRARY_ID, itemId: id, revision: childText(entry, ATOM_NS, "updated") },
    kind: "paper",
    title,
    ...(authors.length ? { authors } : {}),
    ...(childText(entry, ATOM_NS, "summary") ? { summary: childText(entry, ATOM_NS, "summary") } : {}),
    ...(childText(entry, ATOM_NS, "published") ? { publishedAt: childText(entry, ATOM_NS, "published") } : {}),
    ...(childText(entry, ATOM_NS, "updated") ? { updatedAt: childText(entry, ATOM_NS, "updated") } : {}),
    canonicalUrl: `${ARXIV_ORIGIN}/abs/${id}`,
    ...(licenseUrl ? { license: { name: "Article license", url: licenseUrl } } : {}),
    ...(subjects.length ? { subjects } : {}),
    offers: [{ id: "pdf", label: "Article PDF", outputType: "pdf", importKind: "download", mediaType: "application/pdf", extension: "pdf", risk: "ordinary-content" }],
  };
}

export class ArxivForeignLibrary implements ForeignLibraryPlugin {
  readonly manifest: ForeignLibraryManifest = {
    apiVersion: FOREIGN_LIBRARY_API,
    id: ARXIV_LIBRARY_ID,
    version: "1.0.0",
    name: "arXiv",
    description: "Search research e-prints and import PDFs for personal reading. Thank you to arXiv for use of its open access interoperability.",
    homepage: ARXIV_ORIGIN,
    capabilities: ["catalog.search", "catalog.browse", "item.resolve", "item.acquire"],
    outputs: [{ type: "pdf", label: "PDF", delivery: ["download"], mediaTypes: ["application/pdf"], extensions: ["pdf"] }],
    permissions: {
      networkOrigins: [EXPORT_ORIGIN],
      manualDownloadOrigins: [ARXIV_ORIGIN],
      rateLimit: { maxConcurrent: 1, minIntervalMs: 3_000 },
      maxResponseBytes: INGESTION_LIMITS.maxFileBytes,
    },
  };

  constructor(private readonly parseXml: XmlParser = (source) => new DOMParser().parseFromString(source, "application/xml")) {}

  async open(host: ForeignLibraryHost): Promise<ForeignLibrarySession> {
    const cached = new Map<string, ForeignItem>();

    const fetchFeed = async (url: URL, signal?: AbortSignal): Promise<Document> => {
      const response = await host.request({
        url: url.toString(),
        signal,
        gateway: { route: "catalog" },
        timeoutMs: 30_000,
        maxResponseBytes: MAX_CATALOG_BYTES,
        headers: { Accept: "application/atom+xml" },
      });
      if (response.status !== 200) throw new ForeignLibraryError("acquisition-failed", `arXiv returned ${response.status}.`, response.status >= 500);
      const document = this.parseXml(new TextDecoder().decode(response.body));
      if (document.getElementsByTagName("parsererror").length > 0) throw new ForeignLibraryError("invalid-response", "arXiv returned malformed Atom XML.");
      return document;
    };

    const pageFromFeed = (document: Document, start: number, pageSize: number): ForeignPage<ForeignItem> => {
      const items = [...document.getElementsByTagNameNS(ATOM_NS, "entry")]
        .map(parseEntry)
        .filter((item): item is ForeignItem => Boolean(item));
      items.forEach((item) => cached.set(item.ref.itemId, item));
      const total = Number(document.getElementsByTagNameNS(OPENSEARCH_NS, "totalResults")[0]?.textContent);
      const nextStart = start + items.length;
      return {
        items,
        ...(Number.isSafeInteger(total) && total >= 0 ? { total } : {}),
        ...(items.length === pageSize && (!Number.isSafeInteger(total) || nextStart < total) ? { nextCursor: String(nextStart) } : {}),
      };
    };

    const resolve = async (ref: ForeignItemRef): Promise<ForeignItem> => {
      if (ref.libraryId !== ARXIV_LIBRARY_ID || !/^[A-Za-z0-9./-]+$/u.test(ref.itemId)) {
        throw new ForeignLibraryError("invalid-request", "The paper has an invalid arXiv identifier.");
      }
      const existing = cached.get(ref.itemId);
      if (existing) return existing;
      const url = new URL(`${EXPORT_ORIGIN}/api/query`);
      url.searchParams.set("id_list", ref.itemId);
      url.searchParams.set("max_results", "1");
      const page = pageFromFeed(await fetchFeed(url), 0, 1);
      const item = page.items[0];
      if (!item) throw new ForeignLibraryError("not-found", "arXiv could not find this paper.");
      return item;
    };

    return {
      async browse(request: ForeignBrowseRequest): Promise<ForeignPage<ForeignItem>> {
        const pageSize = Math.min(Math.max(request.pageSize ?? 24, 1), 25);
        const start = request.cursor ? Number(request.cursor) : 0;
        if (!Number.isSafeInteger(start) || start < 0 || start > 10_000) throw new ForeignLibraryError("invalid-request", "The arXiv result cursor is invalid.");
        const url = new URL(`${EXPORT_ORIGIN}/api/query`);
        url.searchParams.set("search_query", "cat:cs.AI OR cat:cs.CL OR cat:cs.LG");
        url.searchParams.set("start", String(start));
        url.searchParams.set("max_results", String(pageSize));
        url.searchParams.set("sortBy", "submittedDate");
        url.searchParams.set("sortOrder", "descending");
        return pageFromFeed(await fetchFeed(url, request.signal), start, pageSize);
      },
      async search(request: ForeignSearchRequest): Promise<ForeignPage<ForeignItem>> {
        const query = safeQuery(request.query);
        if (!query) throw new ForeignLibraryError("invalid-request", "Enter a title, author, abstract term, or arXiv identifier.");
        const pageSize = Math.min(Math.max(request.pageSize ?? 25, 1), 25);
        const start = request.cursor ? Number(request.cursor) : 0;
        if (!Number.isSafeInteger(start) || start < 0 || start > 10_000) throw new ForeignLibraryError("invalid-request", "The arXiv result cursor is invalid.");
        const url = new URL(`${EXPORT_ORIGIN}/api/query`);
        url.searchParams.set("search_query", `all:"${query}"`);
        url.searchParams.set("start", String(start));
        url.searchParams.set("max_results", String(pageSize));
        url.searchParams.set("sortBy", "relevance");
        url.searchParams.set("sortOrder", "descending");
        return pageFromFeed(await fetchFeed(url, request.signal), start, pageSize);
      },
      resolve,
      async planImport(ref, offerId): Promise<ForeignDownloadPlan> {
        if (offerId !== "pdf") throw new ForeignLibraryError("not-found", "The selected arXiv format is unavailable.");
        const item = await resolve(ref);
        return {
          kind: "download",
          acquisition: "manual",
          request: { url: `${ARXIV_ORIGIN}/pdf/${ref.itemId}` },
          file: { name: `${slug(item.title)}-${ref.itemId.replace(/\//gu, "-")}.pdf`, extension: "pdf", mimeType: "application/pdf" },
          provenance: { libraryId: ARXIV_LIBRARY_ID, itemId: ref.itemId, revision: item.ref.revision, canonicalUrl: item.canonicalUrl, license: item.license },
        };
      },
      dispose: () => cached.clear(),
    };
  }
}
