import "./dom-shim.mts";
import { readFile } from "node:fs/promises";
import { exploreEpub, toWordStream } from "../src/epub/explore.ts";

async function main() {
  const arg = process.argv[2];
  const path = !arg || arg === "build" ? "experiments/fixtures/toy.epub" : arg;

  const buf = await readFile(path);
  const data = new Uint8Array(buf);
  const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

  console.log(`=== Opening ${path} ===`);
  const t0 = Date.now();
  const structure = await exploreEpub(arrayBuffer);
  console.log(`parsed in ${Date.now() - t0}ms\n`);

  console.log("=== METADATA ===");
  console.log(JSON.stringify(structure.metadata, null, 2));

  console.log("\n=== SPINE (reading order) ===");
  structure.spine.forEach((s) => console.log(`#${s.index} ${s.href} [${s.idref}]`));

  console.log("\n=== NAVIGATION (TOC) — first 40 ===");
  structure.navigation.slice(0, 40).forEach((n, i) => console.log(`${i}: ${n.label} -> ${n.href}`));
  if (structure.navigation.length > 40) console.log(`... and ${structure.navigation.length - 40} more`);

  console.log("\n=== CHAPTER WORD COUNTS ===");
  structure.pages.forEach((p) => console.log(`Ch ${p.chapterId}: ${p.words.length} words`));

  console.log("\n=== FLAT WORD STREAM ===");
  const stream = toWordStream(structure);
  console.log(`totalWords=${stream.meta.totalWords} avgLen=${stream.meta.avgWordLength.toFixed(2)} chapters=${stream.chapterIndex.length}`);
  console.log("\nfirst 40 words:");
  console.log(JSON.stringify(stream.words.slice(0, 40), null, 1));

  console.log("\nfirst 5 chapterIndex entries:");
  console.log(JSON.stringify(stream.chapterIndex.slice(0, 5), null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});