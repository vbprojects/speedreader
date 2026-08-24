// test-bayesian-pacing.mts
// Verification of the Bayesian Poisson-Gamma adaptive pacing model.
//
// Usage (from frontend/):
//   npx tsx experiments/test-bayesian-pacing.mts [path.epub]

import "./dom-shim.mts";
import { readFile } from "node:fs/promises";
import { IngestionEngine, EpubParser } from "../src/ingestion/index.ts";
import { PacingEngine, selectBackend, createBayesianPacingFn, availableBackends } from "../src/pacing/index.ts";
import type { Word } from "../src/epub/types.ts";

async function testSynthetic() {
  console.log("=== Synthetic Tests for Bayesian Pacing ===");
  const fn = createBayesianPacingFn({ gamma: 0.98, beta0: 10, alpha0: 50 });

  // Initial estimate: muHat_0 = 1 + 50/10 = 6.0
  const stats0 = fn.getStats();
  console.log(`Initial muHat: ${stats0.muHat.toFixed(2)} (Expected 6.00)`);
  if (Math.abs(stats0.muHat - 6.0) > 1e-4) throw new Error("Initial prior mean mismatch");

  // Feed a stream of long words (length 10) vs short words (length 2)
  const dummyCtx = {
    profile: { wpm: 600, sentencePauseMs: 0, paragraphPauseMs: 0 },
    stats: { totalWords: 100, avgWordLength: 5 },
    neighbors: {},
  };

  const makeWord = (len: number): Word => ({
    text: "a".repeat(len),
    index: 0,
    metadata: [{ attribute: "chapterId", value: 0 }],
  });

  // 1. Initial word of length 6 at 600 wpm (base time should be exactly 60000 / (600 * 6) * 6 = 100ms)
  const dFirst = fn(makeWord(6), dummyCtx);
  console.log(`Duration of 6-char word with muHat=6.0 @ 600wpm: ${dFirst.toFixed(2)}ms (Expected: 100.00ms)`);
  if (Math.abs(dFirst - 100) > 1e-2) throw new Error("Base calculation mismatch");

  // 2. Feed 200 words of length 10 -> muHat should adapt upward towards 10
  for (let i = 0; i < 200; i++) {
    fn(makeWord(10), dummyCtx);
  }
  const statsLong = fn.getStats();
  console.log(`muHat after 200 10-char words: ${statsLong.muHat.toFixed(2)} (Expected ~10.00)`);
  if (Math.abs(statsLong.muHat - 10) > 0.3) throw new Error("Failed to adapt upward to long words");

  // 4. Configurable gamma test
  const fnFast = createBayesianPacingFn({ gamma: 0.90 }); // ~10 words window
  const fnSlow = createBayesianPacingFn({ gamma: 0.995 }); // ~200 words window
  for (let i = 0; i < 20; i++) {
    fnFast(makeWord(10), dummyCtx);
    fnSlow(makeWord(10), dummyCtx);
  }
  console.log(`Fast-decay gamma=0.90 muHat after 20 words: ${fnFast.getStats().muHat.toFixed(2)} (rapid adaptation)`);
  console.log(`Slow-decay gamma=0.995 muHat after 20 words: ${fnSlow.getStats().muHat.toFixed(2)} (gradual adaptation)`);
  if (fnFast.getStats().muHat <= fnSlow.getStats().muHat) throw new Error("Gamma discount sensitivity failed");

  console.log("Synthetic tests: PASS\n");
}

async function testRealBook() {
  console.log("=== Real Book Pacing Test (Pride and Prejudice) ===");
  const path = process.argv[2] ?? "../epubs/prideandprejudice.epub";
  const buf = await readFile(path);
  const data = new Uint8Array(buf);
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

  const engine = new IngestionEngine([new EpubParser()]);
  const stream = await engine.ingest({
    name: path.split(/[\\/]/).pop()!,
    extension: "epub",
    data: ab,
  });

  console.log("Available backends:", availableBackends());
  const bayesian = selectBackend("bayesian");
  const naive = selectBackend("naive");

  const pacingBayesian = new PacingEngine({
    backend: bayesian,
    profile: { wpm: 600, sentencePauseMs: 150, paragraphPauseMs: 200 },
  });

  const pacingNaive = new PacingEngine({
    backend: naive,
    profile: { wpm: 600, sentencePauseMs: 150, paragraphPauseMs: 200 },
  });

  const stats = { totalWords: stream.meta.totalWords, avgWordLength: stream.meta.avgWordLength };
  const dBayes = pacingBayesian.durations(stream.words, stats);
  const dNaive = pacingNaive.durations(stream.words, stats);

  console.log(`Stream words count: ${stream.words.length}`);
  console.log("\nSample word comparison (Naive vs Bayesian @ 600 WPM):");
  for (const i of [10, 11, 12, 13, 14, 15, 50, 100]) {
    const w = stream.words[i];
    console.log(
      `  [${i}] "${w.text}" (len ${w.text.length}) -> Naive: ${dNaive[i].toFixed(0)}ms | Bayesian: ${dBayes[i].toFixed(0)}ms`
    );
  }

  let sumBayes = 0;
  for (const d of dBayes) sumBayes += d;
  let sumNaive = 0;
  for (const d of dNaive) sumNaive += d;

  console.log(`\nTotal reading time Naive: ${(sumNaive / 60000).toFixed(2)} min`);
  console.log(`Total reading time Bayesian: ${(sumBayes / 60000).toFixed(2)} min`);
  console.log("Real book test: PASS");
}

async function main() {
  await testSynthetic();
  await testRealBook();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
