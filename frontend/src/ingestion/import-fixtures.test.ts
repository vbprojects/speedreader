import { deepStrictEqual, equal, match, doesNotMatch } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { HtmlTextParser, TextParser, textFile, textToStream } from "./text";
import { detectSugarCubeSource } from "./sugarcube/detect";
import { formatAssistantText } from "./openai-compatible/formatter";
import { streamText } from "../library/reading-info";

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const parseHtml = (html: string) => new JSDOM(html).window.document;

test("saved HTML extracts article text and paragraph boundaries without site chrome or scripts", async () => {
  const file = { ...textFile(await fixture("messy-page.html")), name: "messy-page.html", extension: "html", mimeType: "text/html" };
  const parser = new HtmlTextParser(parseHtml);
  const stream = await parser.parse(file);
  const text = streamText(stream);
  match(text, /Plants turn sunlight into stored energy\./);
  match(text, /A second paragraph includes important context\./);
  doesNotMatch(text, /Subscribe|Shop|Never execute|Invisible|products|Cookie/);
  equal((await parser.getBookInfo(file)).title, "A small discovery");
  equal(stream.words.filter((word) => word.formatting?.lineBreaksBefore).length, 2);
});

test("published SugarCube fixture preserves branching source without executing or flattening it", async () => {
  const html = await fixture("branching-story.html");
  const file = { ...textFile(html), extension: "html", mimeType: "text/html" };
  const result = detectSugarCubeSource({ file, sourceHash: "a".repeat(64), parseHtml });
  equal(result?.source.story.title, "A fork in the path");
  equal(result?.source.story.startNode, "1");
  match(result?.source.html ?? "", /\[\[Take the left path->Left\]\]/);
  match(result?.source.html ?? "", /\[\[Take the right path->Right\]\]/);
});

test("Markdown response fixture retains words and owning turn for the current literal-text projection", async () => {
  const text = await fixture("assistant-response.md");
  const words = formatAssistantText(text, "fixture-turn");
  equal(words.map((word) => word.text).join(" "), text.trim().replace(/\s+/gu, " "));
  equal(words.every((word, index) => word.index === index && word.metadata.some((item) => item.attribute === "llmTurnId" && item.value === "fixture-turn")), true);
});

test("text preview and cleanup preserve paragraph boundaries and assign stable indices", async () => {
  const original = "A short paragraph.\n\nA second paragraph.";
  const parsed = await new TextParser().parse(textFile(original));
  equal(streamText(parsed), original);
  deepStrictEqual(textToStream(streamText(parsed)).words, parsed.words);
});

test("native-text PDF fixture produces usable ordered words through PDF.js", async () => {
  // PDF.js's Node entry supplies the DOM geometry primitives used by its browser entry.
  await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { PdfJsParser } = await import("./pdf/parser");
  const bytes = await readFile(new URL("./fixtures/simple.pdf", import.meta.url));
  const stream = await new PdfJsParser().parse({ name: "simple.pdf", extension: "pdf", data: Uint8Array.from(bytes).buffer });
  equal(stream.words.map((word) => word.text).join(" "), "A quiet morning. Reading begins with a single sentence.");
  equal(stream.words.every((word, index) => word.index === index), true);
  equal(stream.chapterIndex.length, 1);
  equal(stream.meta.isComplete, true);
});
