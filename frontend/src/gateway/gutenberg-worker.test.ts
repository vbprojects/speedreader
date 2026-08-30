import { equal, match } from "node:assert/strict";
import { test } from "node:test";
import { GUTENBERG_GATEWAY_MAX_BYTES, handleGutenbergGateway } from "./gutenberg-worker";

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
