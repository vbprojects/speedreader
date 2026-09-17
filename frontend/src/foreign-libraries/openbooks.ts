import { FOREIGN_LIBRARY_API, ForeignLibraryError, type ForeignLibraryPlugin, type ForeignLibraryManifest,
  type ForeignLibraryHost, type ForeignItem, type ForeignItemRef } from "./types";

export interface OpenBooksSource { id: string; name: string; baseUrl: string; }
export function openBooksBaseUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTPS OpenBooks URL without credentials, query parameters or a fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  return url.href;
}
export const OPENBOOKS_STORAGE = "speedreader.openbooks.sources.v1";
export function loadOpenBooksSources(): OpenBooksSource[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(OPENBOOKS_STORAGE) ?? "[]");
    if (!Array.isArray(rows)) return [];
    const ids = new Set<string>(), urls = new Set<string>();
    return rows.slice(0, 10).filter((r): r is OpenBooksSource => {
      try {
        if (!r || typeof r.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(r.id) ||
          typeof r.name !== "string" || !r.name.trim() || r.name.length > 80 ||
          typeof r.baseUrl !== "string" || openBooksBaseUrl(r.baseUrl) !== r.baseUrl ||
          ids.has(r.id) || urls.has(r.baseUrl)) return false;
        ids.add(r.id); urls.add(r.baseUrl); return true;
      } catch { return false; }
    });
  } catch { return []; }
}

/** Observed OpenBooks protocol (ad12382). Only CONNECT and SEARCH are sent. */
export class OpenBooksForeignLibrary implements ForeignLibraryPlugin {
  readonly manifest: ForeignLibraryManifest;
  private nextSearchAt = 0;
  private busy = false;
  constructor(readonly source: OpenBooksSource) {
    const base = openBooksBaseUrl(source.baseUrl);
    const ws = new URL("ws", base); ws.protocol = "wss:";
    this.manifest = { apiVersion: FOREIGN_LIBRARY_API, id: `org.openbooks.${source.id}`, version: "0.1.0",
      name: source.name, description: "Search your OpenBooks server. Download on its website, then choose the file to import.",
      homepage: base, capabilities: ["catalog.search", "item.resolve", "item.acquire"],
      outputs: ["epub", "pdf"].map(type => ({ type: type as "epub" | "pdf", label: type.toUpperCase(), delivery: ["download"] })),
      permissions: { networkOrigins: [], manualDownloadOrigins: [new URL(base).origin], webSocketUrls: [ws.href] } };
  }
  async open(host: ForeignLibraryHost) {
    let cancel: (() => void) | undefined;
    let disposed = false;
    const items = new Map<string, ForeignItem>();
    const resolve = async (ref: ForeignItemRef) => {
      const item = items.get(ref.itemId);
      if (ref.libraryId !== this.manifest.id || !item) throw new ForeignLibraryError("not-found", "Search again to select this result.");
      return item;
    };
    return {
      search: async ({ query, signal }: { query: string; signal?: AbortSignal }) => {
        if (disposed || signal?.aborted) throw new ForeignLibraryError("cancelled", "Search cancelled.");
        query = query.trim();
        if (!query || new TextEncoder().encode(JSON.stringify({ type: 2, payload: { query } })).length > 500 || /[\r\n\0]/.test(query)) {
          throw new ForeignLibraryError("invalid-request", "Enter a shorter, single-line search query.");
        }
        if (this.busy || Date.now() < this.nextSearchAt) throw new ForeignLibraryError("rate-limited", "Wait at least ten seconds between searches.", true);
        if (!host.openWebSocket) throw new ForeignLibraryError("unsupported", "Direct WebSocket search is unavailable.");
        this.busy = true;
        this.nextSearchAt = Date.now() + 10000;
        try {
          const books = await new Promise<unknown[]>((accept, reject) => {
            const socket = host.openWebSocket!(this.manifest.permissions.webSocketUrls![0]);
            let done = false, sent = false;
            const finish = (error?: Error, result: unknown[] = []) => {
              if (done) return; done = true; clearTimeout(timer);
              signal?.removeEventListener("abort", abort); cancel = undefined;
              socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
              socket.close(); // Release the server before manual browser handoff.
              if (error) reject(error); else accept(result);
            };
            const abort = () => finish(new ForeignLibraryError("cancelled", "Search cancelled."));
            const timer = setTimeout(() => finish(new ForeignLibraryError("network-unavailable", "OpenBooks search timed out. Close other OpenBooks tabs and retry.", true)), 60000);
            cancel = abort; signal?.addEventListener("abort", abort, { once: true });
            socket.onopen = () => socket.send(JSON.stringify({ type: 1, payload: {} }));
            socket.onerror = () => finish(new ForeignLibraryError("network-unavailable", "Cannot connect to OpenBooks. Check HTTPS, WebSocket access and whether another client is connected.", true));
            socket.onclose = () => finish(new ForeignLibraryError("network-unavailable", "OpenBooks disconnected. Retry the search.", true));
            socket.onmessage = event => {
              try {
                if (typeof event.data !== "string" || event.data.length > 2 * 1024 * 1024) throw Error("Invalid or oversized OpenBooks response.");
                const message = JSON.parse(event.data);
                if (!message || !Number.isInteger(message.type)) throw Error("Invalid OpenBooks message.");
                if (message.type === 4 || message.appearance === 3) {
                  throw new ForeignLibraryError(message.type === 4 ? "rate-limited" : "acquisition-failed",
                    String(message.title ?? "OpenBooks rejected the request.").slice(0, 300), true);
                }
                if (message.type === 1 && message.appearance === 1 && !sent) {
                  sent = true; socket.send(JSON.stringify({ type: 2, payload: { query } }));
                } else if (message.type === 2 && sent) {
                  if (!Array.isArray(message.books) || message.books.length > 5000) throw Error("Invalid or oversized search results.");
                  finish(undefined, message.books);
                }
              } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
            };
          });
          items.clear();
          for (const raw of books) {
            if (!raw || typeof raw !== "object") continue;
            const book = raw as Record<string, unknown>;
            if (typeof book.title !== "string" || !book.title.trim() || book.title.length > 500 ||
                typeof book.format !== "string") continue;
            const format = book.format.toLowerCase().replace(/^\./, "");
            if (format !== "epub" && format !== "pdf") continue;
            const itemId = crypto.randomUUID();
            items.set(itemId, { ref: { libraryId: this.manifest.id, itemId }, kind: "book", title: book.title,
              authors: typeof book.author === "string" && book.author.trim() ? [book.author.slice(0, 200)] : undefined,
              summary: `Manual download from ${new URL(this.source.baseUrl).host}. Search there for: ${query}`,
              metadata: { query }, offers: [{ id: format, label: "Download on OpenBooks", outputType: format,
                extension: format, importKind: "download" }] });
          }
          return { items: [...items.values()] };
        } finally { this.busy = false; }
      },
      resolve,
      planImport: async (ref: ForeignItemRef, offerId: string) => {
        const item = await resolve(ref);
        const offer = item.offers.find(o => o.id === offerId);
        if (!offer) throw new ForeignLibraryError("not-found", "Unknown file format.");
        cancel?.();
        return { kind: "download" as const, acquisition: "manual" as const, manualAction: "source-page" as const,
          request: { url: openBooksBaseUrl(this.source.baseUrl) },
          file: { name: `${item.title.replace(/[/\\\p{Cc}]/gu, "_")}.${offerId}`, extension: offerId },
          provenance: { libraryId: this.manifest.id, itemId: item.ref.itemId,
            canonicalUrl: openBooksBaseUrl(this.source.baseUrl), license: { notice: "Rights unknown. Manually selected file; correspondence to search result is unverified." } } };
      },
      dispose: () => { disposed = true; cancel?.(); items.clear(); },
    };
  }
}
