// Offline comparison of naive, length-adaptive Bayesian, and experimental
// character-trigram surprisal pacing.
//
// Usage (from frontend/):
//   npx tsx experiments/test-surprisal-pacing.mts [path.epub]

import "./dom-shim.mts";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestionEngine, EpubParser } from "../src/ingestion/index.ts";
import { PacingEngine, selectBackend } from "../src/pacing/index.ts";
import { createSurprisalPacingFn } from "../src/pacing/surprisal.ts";

const path = process.argv[2] ?? "../epubs/prideandprejudice.epub";
const outputPath = process.argv[3] ?? join(tmpdir(), "speedreader-surprisal-pacing-results.csv");
const wpm = 600;

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

function summarize(name: string, durations: number[]): void {
  const sorted = [...durations].sort((a, b) => a - b);
  const total = durations.reduce((sum, value) => sum + value, 0);
  console.log(
    `${name.padEnd(20)} mean=${(total / durations.length).toFixed(1)}ms ` +
    `p10=${percentile(sorted, 0.1).toFixed(1)} p50=${percentile(sorted, 0.5).toFixed(1)} ` +
    `p90=${percentile(sorted, 0.9).toFixed(1)} total=${(total / 60_000).toFixed(2)}min`,
  );
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main(): Promise<void> {
  const buffer = await readFile(path);
  const data = new Uint8Array(buffer);
  const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const stream = await new IngestionEngine([new EpubParser()]).ingest({
    name: path.split(/[\\/]/).pop()!,
    extension: "epub",
    data: arrayBuffer,
  });
  const stats = { totalWords: stream.meta.totalWords, avgWordLength: stream.meta.avgWordLength };
  const profile = { wpm, sentencePauseMs: 0, paragraphPauseMs: 0 };

  const naive = new PacingEngine({ backend: selectBackend("naive"), profile });
  const lengthBayesian = new PacingEngine({ backend: selectBackend("bayesian"), profile });
  const exponentialGammaFn = createSurprisalPacingFn({ scoreModel: "exponential-gamma" });
  const normalFn = createSurprisalPacingFn({ scoreModel: "normal" });

  const naiveDurations = naive.durations(stream.words, stats);
  const lengthDurations = lengthBayesian.durations(stream.words, stats);
  const exponentialGammaDurations: number[] = [];
  const normalDurations: number[] = [];
  const rows = ["index,word,length,raw_surprisal,expected_surprisal,relative_difficulty,exp_gamma_multiplier,naive_ms,length_bayesian_ms,normal_ms,exp_gamma_ms"];

  for (let i = 0; i < stream.words.length; i += 1) {
    const current = stream.words[i];
    const pacingContext = {
      profile,
      stats,
      neighbors: { prev: stream.words[i - 1], next: stream.words[i + 1] },
    };
    const exponentialGammaDuration = exponentialGammaFn(current, pacingContext);
    const normalDuration = normalFn(current, pacingContext);
    const diagnostics = exponentialGammaFn.getStats();
    exponentialGammaDurations.push(exponentialGammaDuration);
    normalDurations.push(normalDuration);
    rows.push([
      i,
      current.text,
      current.text.length,
      diagnostics.lastRawSurprisal,
      diagnostics.expectedScore,
      diagnostics.lastRelativeDifficulty,
      diagnostics.lastMultiplier,
      naiveDurations[i],
      lengthDurations[i],
      normalDuration,
      exponentialGammaDuration,
    ].map(csvCell).join(","));
  }

  console.log(`\n${stream.words.length} words from ${path} at target ${wpm} WPM`);
  summarize("naive", naiveDurations);
  summarize("length-bayesian", lengthDurations);
  summarize("trigram-normal", normalDurations);
  summarize("trigram-exp-gamma", exponentialGammaDurations);
  console.log("\nAssumption: first occurrences use words-since-session-start as a left-censored gap approximation.");
  console.log(`Final sparse table: ${exponentialGammaFn.getStats().entries} entries (${exponentialGammaFn.getStats().prunedEntries} pruned)`);

  await writeFile(outputPath, `${rows.join("\n")}\n`, "utf8");
  console.log(`Per-word results: ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
