import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { ForeignImportCoordinator } from "./coordinator";
import { GUTENBERG_LIBRARY_ID, GutenbergForeignLibrary } from "./gutenberg";
import { ForeignLibraryRegistry } from "./registry";
import { filterForeignLibraries, foreignOutputFilters } from "./browser";
import { ConstrainedForeignLibraryHost } from "./transport";
import { manualForeignDownload } from "./manual-download";
import {
  FOREIGN_LIBRARY_API,
  ForeignLibraryError,
  type ForeignLibraryHost,
  type ForeignLibraryManifest,
  type ForeignLibraryPlugin,
  type ForeignResponse,
} from "./types";
import { validateForeignManifest } from "./validation";

const TEST_MANIFEST: ForeignLibraryManifest = {
  apiVersion: FOREIGN_LIBRARY_API,
  id: "test.example.library",
  version: "1.0.0",
  name: "Test Library",
  description: "A test Foreign Library.",
  capabilities: ["catalog.search", "item.resolve", "item.acquire"],
  outputs: [{
    type: "epub",
    label: "EPUB",
    delivery: ["download"],
    mediaTypes: ["application/epub+zip"],
    extensions: ["epub"],
  }],
  permissions: { networkOrigins: ["https://catalog.example"], maxResponseBytes: 32 },
};

function foreignResponse(body: string | Uint8Array, url = "https://www.gutenberg.org/ebooks/search.opds/"): ForeignResponse {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return { status: 200, statusText: "OK", url, headers: { "content-type": "application/atom+xml" }, body: bytes.buffer as ArrayBuffer };
}

test("manifest validation requires namespaced IDs, exact HTTPS origins, and matching API versions", () => {
  equal(validateForeignManifest(TEST_MANIFEST).id, TEST_MANIFEST.id);
  rejects(async () => validateForeignManifest({ ...TEST_MANIFEST, id: "invalid" }), /namespaced/);
  rejects(async () => validateForeignManifest({ ...TEST_MANIFEST, permissions: { networkOrigins: ["https://catalog.example/path"] } }), /exact HTTPS origins/);
  rejects(async () => validateForeignManifest({ ...TEST_MANIFEST, apiVersion: "future" as typeof FOREIGN_LIBRARY_API }), /Unsupported/);
});

test("manifest validation requires unique, usable output declarations", () => {
  equal(validateForeignManifest(TEST_MANIFEST).outputs[0].type, "epub");
  rejects(async () => validateForeignManifest({ ...TEST_MANIFEST, outputs: [] }), /output declarations/);
  rejects(async () => validateForeignManifest({
    ...TEST_MANIFEST,
    outputs: [...TEST_MANIFEST.outputs, { ...TEST_MANIFEST.outputs[0] }],
  }), /output types must be unique/);
  rejects(async () => validateForeignManifest({
    ...TEST_MANIFEST,
    outputs: [{ type: "x-unsafe/type", label: "Unsafe", delivery: ["download"] }],
  }), /output type is invalid/);
});

test("library browser exposes built-in output filters and filters manifest lists", () => {
  const htmlManifest: ForeignLibraryManifest = {
    ...TEST_MANIFEST,
    id: "test.example.html",
    name: "HTML Library",
    outputs: [{ type: "html", label: "HTML", delivery: ["download"], mediaTypes: ["text/html"], extensions: ["html"] }],
  };
  const customManifest: ForeignLibraryManifest = {
    ...TEST_MANIFEST,
    id: "test.example.custom",
    name: "Markdown Library",
    outputs: [{ type: "x-markdown", label: "Markdown", delivery: ["download"], mediaTypes: ["text/markdown"], extensions: ["md"] }],
  };
  const manifests = [TEST_MANIFEST, htmlManifest, customManifest];
  deepStrictEqual(foreignOutputFilters(manifests).map((filter) => filter.label), [
    "EPUB", "HTML", "PDF", "JSON response", "SugarCube", "Markdown",
  ]);
  deepStrictEqual(filterForeignLibraries(manifests, "html").map((manifest) => manifest.id), [htmlManifest.id]);
  deepStrictEqual(filterForeignLibraries(manifests, "pdf"), []);
  equal(filterForeignLibraries(manifests, "all").length, 3);
});

test("constrained transport denies undeclared origins, forbidden headers, and oversized bodies", async () => {
  const fetchImpl: typeof fetch = async () => new Response("12345", { status: 200, headers: { "Content-Length": "5" } });
  const host = new ConstrainedForeignLibraryHost(TEST_MANIFEST, fetchImpl);
  await rejects(() => host.request({ url: "https://attacker.example/data" }), /not permitted/);
  await rejects(() => host.request({ url: "https://catalog.example/data", headers: { Cookie: "secret" } }), /cannot set the Cookie header/);
  await rejects(() => host.request({ url: "https://catalog.example/data", maxResponseBytes: 4 }), /exceeds/);
});

test("default transport fetch keeps the browser global as its receiver", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (this: typeof globalThis) {
    equal(this, globalThis);
    return Promise.resolve(new Response("ok", { status: 200 }));
  } as typeof fetch;
  try {
    const host = new ConstrainedForeignLibraryHost(TEST_MANIFEST);
    const response = await host.request({ url: "https://catalog.example/data" });
    equal(new TextDecoder().decode(response.body), "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preferred downloads use the configured gateway while retaining the validated source URL", async () => {
  let requestedUrl = "";
  const fetchImpl: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return new Response("epub", {
      status: 200,
      headers: {
        "Content-Length": "4",
        "Content-Type": "application/epub+zip",
        "X-Speedreader-Source-Url": "https://catalog.example/cache/book.epub",
      },
    });
  };
  const host = new ConstrainedForeignLibraryHost(
    TEST_MANIFEST,
    fetchImpl,
    undefined,
    "https://gateway.example/v1/gutenberg",
  );
  const response = await host.request({ url: "https://catalog.example/book.epub", gateway: "preferred" });
  equal(requestedUrl, "https://gateway.example/v1/gutenberg?url=https%3A%2F%2Fcatalog.example%2Fbook.epub");
  equal(response.url, "https://catalog.example/cache/book.epub");
});

test("an invalid gateway setting degrades to direct fetch for the manual fallback path", async () => {
  let requestedUrl = "";
  const host = new ConstrainedForeignLibraryHost(TEST_MANIFEST, async (input) => {
    requestedUrl = String(input);
    return new Response("epub", { headers: { "Content-Length": "4" } });
  }, undefined, "javascript:alert(1)");
  await host.request({ url: "https://catalog.example/book.epub", gateway: "preferred" });
  equal(requestedUrl, "https://catalog.example/book.epub");
});

const SEARCH_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>https://www.gutenberg.org/ebooks/1342.opds</id>
    <title>Pride and Prejudice</title>
    <content type="text">Jane Austen</content>
    <link rel="subsection" href="/ebooks/1342.opds" />
  </entry>
</feed>`;

const DETAIL_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dcterms="http://purl.org/dc/terms/">
  <entry>
    <id>urn:gutenberg:1342:2</id>
    <title>Pride and Prejudice</title>
    <updated>2026-01-01T00:00:00Z</updated>
    <published>1998-06-01T00:00:00Z</published>
    <rights>Public domain in the USA.</rights>
    <author><name>Austen, Jane</name></author>
    <category scheme="http://purl.org/dc/terms/LCSH" term="Love stories" />
    <dcterms:language>en</dcterms:language>
    <link rel="http://opds-spec.org/acquisition" type="application/epub+zip" title="EPUB (no images)" length="1000" href="https://www.gutenberg.org/ebooks/1342.epub.noimages" />
  </entry>
  <entry>
    <id>urn:gutenberg:1342:3</id>
    <title>Pride and Prejudice</title>
    <updated>2026-01-01T00:00:00Z</updated>
    <author><name>Austen, Jane</name></author>
    <link rel="http://opds-spec.org/acquisition" type="application/epub+zip" title="EPUB3 with images" length="2000" href="https://www.gutenberg.org/ebooks/1342.epub3.images" />
  </entry>
</feed>`;

test("Gutenberg plugin searches OPDS, resolves editions, and plans the preferred EPUB", async () => {
  const requests: string[] = [];
  const host: ForeignLibraryHost = {
    async request(request) {
      requests.push(request.url);
      return request.url.includes("search.opds")
        ? foreignResponse(SEARCH_XML, request.url)
        : foreignResponse(DETAIL_XML, request.url);
    },
  };
  const parseXml = (source: string) => new JSDOM(source, { contentType: "application/xml" }).window.document as unknown as Document;
  const session = await new GutenbergForeignLibrary(parseXml).open(host);
  const page = await session.search!({ query: "Pride and Prejudice" });
  equal(page.items.length, 1);
  equal(page.items[0].ref.itemId, "1342");
  const item = await session.resolve(page.items[0].ref);
  equal(item.authors?.[0], "Austen, Jane");
  equal(item.language, "en");
  deepStrictEqual(item.subjects, ["Love stories"]);
  equal(item.offers[0].label, "EPUB3 with images");
  equal(item.offers[0].outputType, "epub");
  const plan = await session.planImport(item.ref, "epub-preferred");
  equal(plan.kind, "download");
  equal(plan.request.url, "https://www.gutenberg.org/ebooks/1342.epub3.images");
  equal(plan.request.gateway, "preferred");
  equal(plan.file.extension, "epub");
  equal(plan.provenance.libraryId, GUTENBERG_LIBRARY_ID);
  equal(requests.length, 2, "resolved catalog details should be cached for acquisition");
});

test("manual download fallback is limited to safe gateway acquisition failures", () => {
  const registry = new ForeignLibraryRegistry(() => ({ request: async () => { throw new Error("unused"); } }));
  registry.register({
    manifest: TEST_MANIFEST,
    async open() { throw new Error("unused"); },
  });
  const plan = {
    kind: "download" as const,
    request: { url: "https://catalog.example/book.epub", gateway: "preferred" as const },
    file: { name: "book.epub", extension: "epub" },
    provenance: { libraryId: TEST_MANIFEST.id, itemId: "book-1" },
  };
  const fallback = manualForeignDownload(plan, registry, new ForeignLibraryError("network-unavailable", "offline"));
  equal(fallback?.url, "https://catalog.example/book.epub");
  equal(manualForeignDownload(plan, registry, new Error("parser failed")), null);
  equal(manualForeignDownload({ ...plan, request: { ...plan.request, url: "https://attacker.example/book.epub" } }, registry, new ForeignLibraryError("network-unavailable", "offline")), null);
});

test("registry validates plugin capabilities and coordinator returns parser-ready bytes", async () => {
  const body = new Uint8Array([80, 75, 3, 4]);
  const host: ForeignLibraryHost = { request: async (request) => foreignResponse(body, request.url) };
  const plugin: ForeignLibraryPlugin = {
    manifest: TEST_MANIFEST,
    async open() {
      return {
        search: async () => ({ items: [] }),
        resolve: async (ref) => ({ ref, kind: "book", title: "Fixture", offers: [] }),
        planImport: async () => { throw new Error("unused"); },
        dispose: () => undefined,
      };
    },
  };
  const registry = new ForeignLibraryRegistry(() => host);
  registry.register(plugin);
  const coordinator = new ForeignImportCoordinator(registry);
  const acquired = await coordinator.acquire({
    kind: "download",
    request: { url: "https://catalog.example/book.epub" },
    file: { name: "fixture.epub", extension: "epub", mimeType: "application/epub+zip" },
    provenance: { libraryId: TEST_MANIFEST.id, itemId: "book-1" },
  });
  equal(acquired.file.data.byteLength, 4);
  equal(acquired.file.name, "fixture.epub");
  equal(acquired.provenance.itemId, "book-1");
  equal(typeof acquired.provenance.acquiredAt, "string");
});

test("registry rejects offers outside a plugin's declared outputs", async () => {
  const registry = new ForeignLibraryRegistry(() => ({ request: async (request) => foreignResponse("unused", request.url) }));
  registry.register({
    manifest: TEST_MANIFEST,
    async open() {
      return {
        search: async () => ({ items: [] }),
        resolve: async (ref) => ({
          ref,
          kind: "book",
          title: "Undeclared PDF",
          offers: [{ id: "pdf", label: "PDF", outputType: "pdf", importKind: "download" }],
        }),
        planImport: async () => { throw new Error("unused"); },
        dispose: () => undefined,
      };
    },
  });
  const session = await registry.open(TEST_MANIFEST.id);
  await rejects(() => session.resolve({ libraryId: TEST_MANIFEST.id, itemId: "fixture" }), /undeclared output type/);
});

test("coordinator rejects a download that does not match the plugin checksum", async () => {
  const body = new Uint8Array([80, 75, 3, 4]);
  const registry = new ForeignLibraryRegistry(() => ({ request: async (request) => foreignResponse(body, request.url) }));
  registry.register({
    manifest: TEST_MANIFEST,
    async open() {
      return {
        search: async () => ({ items: [] }),
        resolve: async (ref) => ({ ref, kind: "book", title: "Fixture", offers: [] }),
        planImport: async () => { throw new Error("unused"); },
        dispose: () => undefined,
      };
    },
  });
  const coordinator = new ForeignImportCoordinator(registry);
  await rejects(() => coordinator.acquire({
    kind: "download",
    request: { url: "https://catalog.example/book.epub" },
    file: {
      name: "fixture.epub",
      extension: "epub",
      expectedSha256: "0".repeat(64),
    },
    provenance: { libraryId: TEST_MANIFEST.id, itemId: "book-1" },
  }), /did not match the checksum/);
});
