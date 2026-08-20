// test-ingestion.mts
// Headless verification of the IngestionEngine + EpubParser on a real EPUB.
//
// Usage (from frontend/):
//   npx tsx experiments/test-ingestion.mts [path.epub]

import "./dom-shim.mts";
import { readFile } from "node:fs/promises";
import { IngestionEngine, EpubParser } from "../src/ingestion/index.ts";

async function main() {
  const path = process.argv[2] ?? "../epubs/prideandprejudice.epub";
  const buf = await readFile(path);
  const data = new Uint8Array(buf);
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

  const engine = new IngestionEngine([new EpubParser()]);
  console.log("Registered formats:", engine.formats);

  const file = {
    name: path.split(/[\\/]/).pop()!,
    extension: path.split(".").pop()!.toLowerCase(),
    data: ab,
  };

  const t0 = Date.now();
  const stream = await engine.ingest(file);
  console.log(`Parsed in ${Date.now() - t0}ms`);

  console.log(`\nWords: ${stream.meta.totalWords}`);
  console.log(`Avg word length: ${stream.meta.avgWordLength.toFixed(2)}`);
  console.log(`Chapters: ${stream.chapterIndex.length}`);
  console.log(`Deterministic: ${stream.meta.isDeterministic}`);
  console.log(`Chapter attribute: ${stream.meta.chapterAttribute}`);

  console.log("\nFirst 5 chapters:");
  for (const c of stream.chapterIndex.slice(0, 5)) {
    const first = stream.words[c.startIndex];
    console.log(`  #${c.chapterId} "${c.title}" [${c.startIndex}..${c.endIndex}] first="${first?.text}"`);
  }

  console.log("\nMetadata order (first word of chapter 1):");
  console.log(JSON.stringify(stream.words[stream.chapterIndex[1].startIndex].metadata));

  // Conformance check
  const m = stream.words[stream.chapterIndex[1].startIndex].metadata;
  const order = m.map((x) => x.attribute).join(",");
  const conforms = order === "chapterId,sectionId,paragraphId,spineId";
  console.log(`\n=== CONFORMANCE: ${conforms ? "PASS" : "FAIL"} (${order}) ===`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
