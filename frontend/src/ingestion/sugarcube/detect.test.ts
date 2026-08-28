import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { FileInfo } from "../types";
import { detectSugarCubeDocument, detectSugarCubeSource } from "./detect";
import { InvalidSugarCubeStoryError, SUGARCUBE_EXECUTABLE_WARNING } from "./types";

const HASH = "a".repeat(64);
const parseHtml = (html: string) => new JSDOM(html).window.document;

function publishedStory(overrides = ""): string {
  return `<!doctype html><html><head><script id="script-sugarcube">window.SugarCube = {};</script></head><body>
    <tw-storydata name="A Small Story" ifid="F00D-CAFE" startnode="1" format="SugarCube" format-version="2.37.3" ${overrides}>
      <tw-passagedata pid="1" name="Start">Hello</tw-passagedata>
    </tw-storydata>
  </body></html>`;
}

function file(html: string, extension = "html", mimeType = "text/html"): FileInfo {
  const bytes = new TextEncoder().encode(html);
  return { name: `story.${extension}`, extension, mimeType, data: bytes.buffer };
}

test("detects published SugarCube metadata without executing story scripts", () => {
  const metadata = detectSugarCubeDocument(publishedStory(), parseHtml);
  deepStrictEqual(metadata, {
    title: "A Small Story",
    ifid: "F00D-CAFE",
    startNode: "1",
    formatVersion: "2.37.3",
  });
  equal((parseHtml(publishedStory()).defaultView as unknown as { SugarCube?: unknown }).SugarCube, undefined);
});

test("returns null for ordinary HTML and other Twine story formats", () => {
  equal(detectSugarCubeDocument("<main>Article</main>", parseHtml), null);
  equal(detectSugarCubeDocument(publishedStory().replace('format="SugarCube"', 'format="Harlowe"'), parseHtml), null);
});

test("rejects SugarCube story data without a bundled runtime or identity", () => {
  throws(
    () => detectSugarCubeDocument(publishedStory().replace('<script id="script-sugarcube">window.SugarCube = {};</script>', ""), parseHtml),
    (error: unknown) => error instanceof InvalidSugarCubeStoryError && /bundled runtime/.test(error.message),
  );
  throws(
    () => detectSugarCubeDocument(publishedStory().replace(' ifid="F00D-CAFE"', ""), parseHtml),
    /missing ifid/,
  );
});

test("creates an immutable-source record keyed by the original byte hash", () => {
  const detected = detectSugarCubeSource({ file: file(publishedStory()), sourceHash: HASH, parseHtml });
  equal(detected?.source.bookId, HASH);
  equal(detected?.source.sourceHash, HASH);
  equal(detected?.source.format, "sugarcube-2-runtime");
  equal(detected?.source.html, publishedStory());
  equal(detected?.warning, SUGARCUBE_EXECUTABLE_WARNING);
});

test("ignores non-HTML candidates and rejects malformed hashes and encodings", () => {
  equal(detectSugarCubeSource({ file: file(publishedStory(), "txt", "text/plain"), sourceHash: HASH, parseHtml }), null);
  throws(() => detectSugarCubeSource({ file: file(publishedStory()), sourceHash: "short", parseHtml }), /SHA-256/);
  const invalidUtf8 = { name: "bad.html", extension: "html", mimeType: "text/html", data: new Uint8Array([0xff]).buffer };
  throws(() => detectSugarCubeSource({ file: invalidUtf8, sourceHash: HASH, parseHtml }), /valid UTF-8/);
});
