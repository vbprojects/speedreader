import { equal, throws } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { WindowLike } from "dompurify";
import { sanitizePresentationHtml } from "./sanitize";
import { validatePresentations } from "./validation";

test("presentation validation accepts boundaries and rejects duplicates", () => {
  const nodes = validatePresentations([
    { schemaVersion: 1, id: "start", boundary: 0, kind: "html", html: "<p>Start</p>" },
    { schemaVersion: 1, id: "end", boundary: 2, kind: "html", html: "<hr>" },
  ], 2);
  equal(nodes.length, 2);
  throws(() => validatePresentations([
    { schemaVersion: 1, id: "same", boundary: 0, kind: "html", html: "<p>A</p>" },
    { schemaVersion: 1, id: "same", boundary: 1, kind: "html", html: "<p>B</p>" },
  ], 2), /duplicate presentation id/);
  throws(() => validatePresentations([
    { schemaVersion: 1, id: "late", boundary: 3, kind: "html", html: "<p>Late</p>" },
  ], 2), /outside the word stream/);
});

test("presentation sanitizer removes active and remote content", () => {
  const dom = new JSDOM("");
  const clean = sanitizePresentationHtml(
    '<p style="position:fixed" onclick="alert(1)"><strong>Safe</strong><a href="https://example.com">link</a><img src="https://example.com/x"><script>bad()</script></p>',
    dom.window as unknown as WindowLike,
  );
  equal(clean, "<p><strong>Safe</strong>link</p>");
});
