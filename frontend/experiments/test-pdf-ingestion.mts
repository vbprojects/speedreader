// test-pdf-ingestion.mts
// Pure tests for the conservative PDF.js text normalizer and suitability gate.
// These do not require a browser, a worker, or a network-backed PDF service.

import assert from "node:assert/strict";
import { classifyTextItems } from "../src/ingestion/pdf/suitability.ts";
import { extractPageWords, reconstructLines } from "../src/ingestion/pdf/reading-order.ts";

function item(str: string, x: number, y: number, width: number, extra: Record<string, unknown> = {}) {
  return {
    str,
    transform: [12, 0, 0, 12, x, y],
    width,
    height: 12,
    dir: "ltr",
    hasEOL: false,
    ...extra,
  };
}

function testSimplePage() {
  const items = [
    item("Hello", 72, 700, 30),
    item("world", 108, 700, 32),
    item("Next", 72, 682, 24),
    item("paragraph", 102, 682, 48),
  ];
  const lines = reconstructLines(items);
  assert.equal(lines.length, 2);
  const words = extractPageWords(items, 1, "i");
  assert.deepEqual(words.map((word) => word.text), ["Hello", "world", "Next", "paragraph"]);
  assert.deepEqual(words[0].metadata, [
    { attribute: "page", value: "i" },
    { attribute: "paragraphId", value: "1:0" },
  ]);
  assert.deepEqual(classifyTextItems(items), { route: "pdfjs", reason: "simple-native-text" });
}

function testHyphenatedLine() {
  const items = [
    item("inter-", 72, 700, 30),
    item("national", 72, 682, 48),
  ];
  const words = extractPageWords(items, 2);
  assert.deepEqual(words.map((word) => word.text), ["international"]);
}

function testAdvancedLayoutGate() {
  const items = [];
  for (let row = 0; row < 6; row++) {
    const y = 700 - row * 16;
    items.push(item("left-column-text", 72, y, 90));
    items.push(item("right-column-text", 360, y, 90));
  }
  assert.deepEqual(classifyTextItems(items), { route: "advanced", reason: "multi-column" });
}

function testImageOnlyAndDirection() {
  assert.deepEqual(classifyTextItems([]), { route: "advanced", reason: "image-only" });
  assert.deepEqual(
    classifyTextItems([item("مرحبا بالعالم", 72, 700, 80, { dir: "rtl" })]),
    { route: "advanced", reason: "vertical-or-rtl" }
  );
}

testSimplePage();
testHyphenatedLine();
testAdvancedLayoutGate();
testImageOnlyAndDirection();
console.log("PDF ingestion normalizer tests passed");
