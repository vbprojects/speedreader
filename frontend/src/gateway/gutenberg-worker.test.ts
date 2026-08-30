import { equal, match } from "node:assert/strict";
import { test } from "node:test";
import { CATALOG_GATEWAY_MAX_BYTES, GUTENBERG_GATEWAY_MAX_BYTES, handleCatalogGateway, handleGutenbergGateway } from "./gutenberg-worker";

const APP_ORIGIN = "https://vbprojects.github.io";
const TARGET = "https://www.gutenberg.org/ebooks/1342.epub3.images";

function gatewayRequest(target = TARGET, origin = APP_ORIGIN): Request {
  return new Request(`https://gateway.example/v1/gutenberg?url=${encodeURIComponent(target)}`, {
    headers: { Origin: origin },
  });
}

test("gateway rejects unapproved callers and non-Gutenberg targets", async () => {
  const deniedOrigin = await handleGutenbergGateway(gatewayRequest(TARGET, "https://attacker.example"));
  equal(deniedOrigin.status, 403);

  const deniedTarget = await handleGutenbergGateway(gatewayRequest("https://attacker.example/book.epub"));
  equal(deniedTarget.status, 400);
  match(await deniedTarget.text(), /Unsupported Gutenberg URL/);

  const deniedPath = await handleGutenbergGateway(gatewayRequest("https://www.gutenberg.org/robots.txt"));
  equal(deniedPath.status, 400);
});

test("gateway follows the expected Gutenberg redirect and streams a bounded EPUB", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    equal(init?.redirect, "manual");
    equal(new Headers(init?.headers).get("cookie"), null);
    if (url === TARGET) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/cache/epub/1342/pg1342-images-3.epub" },
      });
    }
    return new Response(new Uint8Array([80, 75, 3, 4]), {
      status: 200,
      headers: { "Content-Length": "4", "Content-Type": "application/epub+zip", ETag: "fixture" },
    });
  };
  const response = await handleGutenbergGateway(gatewayRequest(), { fetchImpl });
  equal(response.status, 200);
  equal(response.headers.get("access-control-allow-origin"), APP_ORIGIN);
  equal(response.headers.get("x-speedreader-source-url"), "https://www.gutenberg.org/cache/epub/1342/pg1342-images-3.epub");
  equal(response.headers.get("cache-control"), "no-store");
  equal((await response.arrayBuffer()).byteLength, 4);
  equal(requests.length, 2);
});

test("gateway rejects cross-origin redirects and unbounded or oversized responses", async () => {
  const redirected = await handleGutenbergGateway(gatewayRequest(), {
    fetchImpl: async () => new Response(null, { status: 302, headers: { Location: "https://attacker.example/book.epub" } }),
  });
  equal(redirected.status, 502);

  const unbounded = await handleGutenbergGateway(gatewayRequest(), {
    fetchImpl: async () => new Response(new Uint8Array([1]), { headers: { "Content-Type": "application/epub+zip" } }),
  });
  equal(unbounded.status, 502);

  const oversized = await handleGutenbergGateway(gatewayRequest(), {
    fetchImpl: async () => new Response(new Uint8Array([1]), {
      headers: { "Content-Length": String(GUTENBERG_GATEWAY_MAX_BYTES + 1), "Content-Type": "application/epub+zip" },
    }),
  });
  equal(oversized.status, 413);
});

test("gateway answers approved CORS preflights without contacting Gutenberg", async () => {
  const response = await handleGutenbergGateway(new Request("https://gateway.example/v1/gutenberg", {
    method: "OPTIONS",
    headers: { Origin: APP_ORIGIN },
  }));
  equal(response.status, 204);
  equal(response.headers.get("access-control-allow-origin"), APP_ORIGIN);
  equal(response.headers.get("access-control-allow-methods"), "GET, OPTIONS");
});

function catalogRequest(target: string, origin = APP_ORIGIN): Request {
  return new Request(`https://gateway.example/v1/catalog?url=${encodeURIComponent(target)}`, {
    headers: { Origin: origin },
  });
}

test("catalog gateway permits only bounded Twine IFDB and arXiv metadata queries", async () => {
  const rejectedHost = await handleCatalogGateway(catalogRequest("https://attacker.example/search?json=&game=&searchfor=system%3ATwine"));
  equal(rejectedHost.status, 400);
  const rejectedIfdb = await handleCatalogGateway(catalogRequest("https://ifdb.org/search?json=&game=&searchfor=adventure"));
  equal(rejectedIfdb.status, 400);
  const rejectedArxiv = await handleCatalogGateway(catalogRequest("https://export.arxiv.org/api/query?search_query=all%3Aai&max_results=26"));
  equal(rejectedArxiv.status, 400);
});

test("catalog gateway returns safe IFDB JSON and arXiv Atom responses", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    if (url.startsWith("https://ifdb.org/")) {
      return new Response('{"games":[]}', { headers: { "Content-Type": "application/json" } });
    }
    return new Response("<feed xmlns=\"http://www.w3.org/2005/Atom\"></feed>", { headers: { "Content-Type": "application/atom+xml" } });
  };
  const ifdb = await handleCatalogGateway(catalogRequest("https://ifdb.org/search?json=&game=&searchfor=system%3ATwine+bird"), { fetchImpl });
  equal(ifdb.status, 200);
  equal(ifdb.headers.get("content-type"), "application/json");
  const arxiv = await handleCatalogGateway(catalogRequest("https://export.arxiv.org/api/query?search_query=all%3Aai&start=0&max_results=10"), { fetchImpl });
  equal(arxiv.status, 200);
  equal(arxiv.headers.get("content-type"), "application/atom+xml");
  equal(requests[0].headers.get("user-agent"), "Speedreader Foreign Library/1.0");
  equal(requests[1].headers.get("user-agent"), "Speedreader Foreign Library/1.0");
});

test("catalog gateway rejects unexpected content and oversized metadata", async () => {
  const wrongType = await handleCatalogGateway(catalogRequest("https://ifdb.org/viewgame?json=&id=ltwvgb2lubkx82yi"), {
    fetchImpl: async () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
  });
  equal(wrongType.status, 502);
  const oversized = await handleCatalogGateway(catalogRequest("https://export.arxiv.org/api/query?id_list=2304.14163&max_results=1"), {
    fetchImpl: async () => new Response("x", { headers: { "Content-Type": "application/atom+xml", "Content-Length": String(CATALOG_GATEWAY_MAX_BYTES + 1) } }),
  });
  equal(oversized.status, 413);
});
