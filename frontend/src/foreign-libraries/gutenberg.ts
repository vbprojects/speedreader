import { INGESTION_LIMITS } from "../ingestion/limits";
import {
  FOREIGN_LIBRARY_API,
  ForeignLibraryError,
  type ForeignDownloadPlan,
  type ForeignItem,
  type ForeignItemRef,
  type ForeignLibraryHost,
  type ForeignLibraryManifest,
  type ForeignLibraryPlugin,
  type ForeignLibrarySession,
  type ForeignOffer,
  type ForeignPage,
  type ForeignSearchRequest,
} from "./types";

const GUTENBERG_ORIGIN = "https://www.gutenberg.org";
const GUTENBERG_LIBRARY_ID = "org.gutenberg.catalog";
const ATOM_NS = "http://www.w3.org/2005/Atom";
const DCTERMS_NS = "http://purl.org/dc/terms/";
const ACQUISITION_REL = "http://opds-spec.org/acquisition";

export type XmlDocumentParser = (source: string) => Document;

interface CachedAcquisition {
  offer: ForeignOffer;
  url: string;
}

function childText(parent: Element, namespace: string, name: string): string | undefined {
  const element = [...parent.children].find((child) => child.namespaceURI === namespace && child.localName === name);
  const value = element?.textContent?.trim();
  return value || undefined;
}

function links(parent: Element): Element[] {
  return [...parent.children].filter((child) => child.namespaceURI === ATOM_NS && child.localName === "link");
}

function absoluteUrl(href: string): string {
  return new URL(href, GUTENBERG_ORIGIN).toString();
}

function itemIdFromUrl(value: string): string {
  const match = value.match(/\/ebooks\/(\d+)(?:\.opds)?(?:$|[/?#])/u);
  if (!match) throw new ForeignLibraryError("invalid-response", "Project Gutenberg returned an invalid book identifier.");
  return match[1];
}

function parse(source: string, parseXml: XmlDocumentParser): Document {
  let document: Document;
  try {
    document = parseXml(source);
  } catch {
    throw new ForeignLibraryError("invalid-response", "Project Gutenberg returned malformed OPDS XML.");
  }
  if (document.getElementsByTagName("parsererror").length) {
    throw new ForeignLibraryError("invalid-response", "Project Gutenberg returned malformed OPDS XML.");
  }
  return document;
}

function text(response: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(response);
}

function slug(value: string): string {
  return value.normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .toLowerCase() || "gutenberg-book";
}

function offerKey(url: string, index: number): string {
  const pathname = new URL(url).pathname;
  const suffix = pathname.split(".").slice(1).join("-").replace(/[^a-z0-9-]/giu, "-").toLowerCase();
  return `epub-${suffix || index}`;
}

function offerPriority(title: string, href: string): number {
  const value = `${title} ${href}`.toLowerCase();
  if (value.includes("epub3") && value.includes("images")) return 0;
  if (value.includes("images")) return 1;
  if (value.includes("epub3")) return 2;
  return 3;
}

export class GutenbergForeignLibrary implements ForeignLibraryPlugin {
  readonly manifest: ForeignLibraryManifest = {
    apiVersion: FOREIGN_LIBRARY_API,
    id: GUTENBERG_LIBRARY_ID,
    version: "1.0.0",
    name: "Project Gutenberg",
    description: "Search and import public-domain EPUB books through Project Gutenberg's OPDS catalog.",
    homepage: GUTENBERG_ORIGIN,
    capabilities: ["catalog.search", "item.resolve", "item.acquire"],
    outputs: [{
      type: "epub",
      label: "EPUB",
      delivery: ["download"],
      mediaTypes: ["application/epub+zip"],
      extensions: ["epub"],
    }],
    permissions: {
      networkOrigins: [GUTENBERG_ORIGIN],
      rateLimit: { maxConcurrent: 1, minIntervalMs: 250 },
      maxResponseBytes: INGESTION_LIMITS.maxFileBytes,
    },
  };

  constructor(private readonly parseXml: XmlDocumentParser = (source) => new DOMParser().parseFromString(source, "application/xml")) {}

  async open(host: ForeignLibraryHost): Promise<ForeignLibrarySession> {
    const cachedItems = new Map<string, ForeignItem>();
    const acquisitions = new Map<string, CachedAcquisition[]>();

    const fetchDocument = async (url: string, signal?: AbortSignal, maxResponseBytes = 2 * 1024 * 1024) => {
      const response = await host.request({ url, signal, timeoutMs: 30_000, maxResponseBytes, headers: { Accept: "application/atom+xml" } });
      if (response.status < 200 || response.status >= 300) {
        throw new ForeignLibraryError("acquisition-failed", `Project Gutenberg returned ${response.status} ${response.statusText}`.trim(), response.status >= 500);
      }
      return parse(text(response.body), this.parseXml);
    };

    const resolve = async (ref: ForeignItemRef): Promise<ForeignItem> => {
      if (ref.libraryId !== GUTENBERG_LIBRARY_ID) throw new ForeignLibraryError("invalid-request", "The book belongs to another library.");
      const existing = cachedItems.get(ref.itemId);
      if (existing && existing.offers.some((offer) => offer.id !== "epub-preferred")) return existing;
      const document = await fetchDocument(`${GUTENBERG_ORIGIN}/ebooks/${encodeURIComponent(ref.itemId)}.opds`);
      const entries = [...document.getElementsByTagNameNS(ATOM_NS, "entry")];
      if (entries.length === 0) throw new ForeignLibraryError("not-found", "Project Gutenberg returned no editions for this book.");
      const first = entries[0];
      const title = childText(first, ATOM_NS, "title") ?? existing?.title ?? `Project Gutenberg #${ref.itemId}`;
      const authorNames = entries.flatMap((entry) => [...entry.getElementsByTagNameNS(ATOM_NS, "author")]
        .map((author) => childText(author, ATOM_NS, "name"))
        .filter((name): name is string => Boolean(name)));
      const subjects = entries.flatMap((entry) => [...entry.getElementsByTagNameNS(ATOM_NS, "category")]
        .filter((category) => category.getAttribute("scheme")?.includes("LCSH"))
        .map((category) => category.getAttribute("term")?.trim())
        .filter((subject): subject is string => Boolean(subject)));
      const candidates: CachedAcquisition[] = [];
      const usedIds = new Set<string>();
      entries.forEach((entry, entryIndex) => {
        links(entry).filter((link) => link.getAttribute("rel") === ACQUISITION_REL && link.getAttribute("type") === "application/epub+zip")
          .forEach((link, linkIndex) => {
            const href = absoluteUrl(link.getAttribute("href") ?? "");
            const label = link.getAttribute("title")?.trim() || "EPUB";
            let id = offerKey(href, entryIndex * 100 + linkIndex);
            while (usedIds.has(id)) id += "-alternate";
            usedIds.add(id);
            const size = Number(link.getAttribute("length"));
            candidates.push({
              url: href,
              offer: {
                id,
                label,
                outputType: "epub",
                importKind: "download",
                mediaType: "application/epub+zip",
                extension: "epub",
                ...(Number.isSafeInteger(size) && size >= 0 ? { byteLength: size } : {}),
                priority: offerPriority(label, href),
                risk: "ordinary-content",
              },
            });
          });
      });
      candidates.sort((a, b) => (a.offer.priority ?? 99) - (b.offer.priority ?? 99) || a.offer.label.localeCompare(b.offer.label));
      if (candidates.length === 0) throw new ForeignLibraryError("unsupported", "This Project Gutenberg item has no EPUB edition.");
      const content = childText(first, ATOM_NS, "content") ?? "";
      const summary = content.match(/Summary:\s*([\s\S]*?)(?:Reading Level:|Author:|EBook No\.:)/u)?.[1]?.trim();
      const item: ForeignItem = {
        ref: { libraryId: GUTENBERG_LIBRARY_ID, itemId: ref.itemId, revision: childText(first, ATOM_NS, "updated") },
        kind: "book",
        title,
        authors: [...new Set(authorNames)],
        ...(summary ? { summary } : {}),
        language: childText(first, DCTERMS_NS, "language"),
        publishedAt: childText(first, ATOM_NS, "published"),
        updatedAt: childText(first, ATOM_NS, "updated"),
        canonicalUrl: `${GUTENBERG_ORIGIN}/ebooks/${ref.itemId}`,
        license: {
          name: childText(first, ATOM_NS, "rights") ?? "Project Gutenberg License",
          url: `${GUTENBERG_ORIGIN}/policy/license.html`,
        },
        subjects: [...new Set(subjects)],
        offers: candidates.map((candidate) => candidate.offer),
      };
      cachedItems.set(ref.itemId, item);
      acquisitions.set(ref.itemId, candidates);
      return item;
    };

    const search = async (request: ForeignSearchRequest): Promise<ForeignPage<ForeignItem>> => {
      const query = request.query.trim();
      if (!query) throw new ForeignLibraryError("invalid-request", "Enter a title or author to search Project Gutenberg.");
      const url = request.cursor
        ? request.cursor
        : `${GUTENBERG_ORIGIN}/ebooks/search.opds/?query=${encodeURIComponent(query)}`;
      const document = await fetchDocument(url, request.signal);
      const items = [...document.getElementsByTagNameNS(ATOM_NS, "entry")].slice(0, Math.min(request.pageSize ?? 25, 25)).map((entry) => {
        const subsection = links(entry).find((link) => link.getAttribute("rel") === "subsection");
        const itemId = itemIdFromUrl(subsection?.getAttribute("href") ?? childText(entry, ATOM_NS, "id") ?? "");
        const author = childText(entry, ATOM_NS, "content");
        const item: ForeignItem = {
          ref: { libraryId: GUTENBERG_LIBRARY_ID, itemId },
          kind: "book",
          title: childText(entry, ATOM_NS, "title") ?? `Project Gutenberg #${itemId}`,
          ...(author ? { authors: [author] } : {}),
          canonicalUrl: `${GUTENBERG_ORIGIN}/ebooks/${itemId}`,
          license: { name: "Project Gutenberg License", url: `${GUTENBERG_ORIGIN}/policy/license.html` },
          offers: [{ id: "epub-preferred", label: "Preferred EPUB", outputType: "epub", importKind: "download", mediaType: "application/epub+zip", extension: "epub", risk: "ordinary-content" }],
        };
        cachedItems.set(itemId, item);
        return item;
      });
      const next = [...document.getElementsByTagNameNS(ATOM_NS, "link")]
        .find((link) => link.parentElement?.localName === "feed" && link.getAttribute("rel") === "next")
        ?.getAttribute("href");
      return { items, ...(next ? { nextCursor: absoluteUrl(next) } : {}) };
    };

    const planImport = async (ref: ForeignItemRef, offerId: string): Promise<ForeignDownloadPlan> => {
      const item = await resolve(ref);
      const available = acquisitions.get(ref.itemId) ?? [];
      const acquisition = offerId === "epub-preferred" ? available[0] : available.find((candidate) => candidate.offer.id === offerId);
      if (!acquisition) throw new ForeignLibraryError("not-found", "The selected EPUB edition is no longer available.");
      return {
        kind: "download",
        request: {
          url: acquisition.url,
          gateway: "preferred",
          timeoutMs: 120_000,
          maxResponseBytes: INGESTION_LIMITS.maxFileBytes,
          headers: { Accept: "application/epub+zip" },
        },
        file: {
          name: `${slug(item.title)}-${ref.itemId}.epub`,
          extension: "epub",
          mimeType: "application/epub+zip",
        },
        provenance: {
          libraryId: GUTENBERG_LIBRARY_ID,
          itemId: ref.itemId,
          revision: item.ref.revision,
          canonicalUrl: item.canonicalUrl,
          license: item.license,
        },
      };
    };

    return { search, resolve, planImport, dispose: () => { cachedItems.clear(); acquisitions.clear(); } };
  }
}

export { GUTENBERG_LIBRARY_ID };
