// test-pacing.mts
// Headless verification of the PacingEngine with the naive backend,
// run over a real parsed WordStream.
//
// Usage (from frontend/):
//   npx tsx experiments/test-pacing.mts [path.epub]

import "./dom-shim.mts";
import { readFile } from "node:fs/promises";
import { IngestionEngine, EpubParser } from "../src/ingestion/index.ts";
import { PacingEngine, naiveBackend, selectBackend, availableBackends } from "../src/pacing/index.ts";

async function main() {
  const path = process.argv[2] ?? "../epubs/prideandprejudice.epub";
  const buf = await readFile(path);
  const data = new Uint8Array(buf);
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

  // 1. Parse a stream.
  const engine = new IngestionEngine([new EpubParser()]);
  const stream = await engine.ingest({
    name: path.split(/[\\/]/).pop()!,
    extension: "epub",
    data: ab,
  });

  // 2. Pacing.
  console.log("Available backends:", availableBackends());
  const backend = selectBackend("naive");
  console.log("Selected backend:", backend.name);

  const pacing = new PacingEngine({
    backend,
    profile: { wpm: 600, sentencePauseMs: 150, paragraphPauseMs: 200 },
  });

  const stats = { totalWords: stream.meta.totalWords, avgWordLength: stream.meta.avgWordLength };
  const durations = pacing.durations(stream.words, stats);

  // 3. Report.
  const base = (60 / 600) * 1000; // 100ms at 600wpm
  console.log(`\nBase duration @600wpm: ${base}ms`);
  console.log(`Words: ${durations.length}`);

  // Show a few sample durations with context.
  console.log("\nSample words (index, text, durationMs):");
  for (const i of [0, 100, 500, 1000, 5000]) {
    const w = stream.words[i];
    console.log(`  [${i}] "${w.text}" -> ${durations[i].toFixed(0)}ms`);
  }

  // Find a sentence-ending word to show the pause.
  const sentIdx = stream.words.findIndex((w) => /[.!?…]$/.test(w.text));
  if (sentIdx >= 0) {
    console.log(`\nSentence-ending word [${sentIdx}] "${stream.words[sentIdx].text}" -> ${durations[sentIdx].toFixed(0)}ms (base + sentence pause)`);
  }

  // Stats (loop, not spread — avoids call-stack overflow on large arrays)
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const d of durations) {
    if (d < min) min = d;
    if (d > max) max = d;
    sum += d;
  }
  const avg = sum / durations.length;
  console.log(`\nDuration stats: min=${min.toFixed(0)}ms max=${max.toFixed(0)}ms avg=${avg.toFixed(1)}ms`);
  console.log(`Total reading time: ${(sum / 60000).toFixed(1)} min @600wpm`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
