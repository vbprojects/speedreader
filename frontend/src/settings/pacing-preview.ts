import type { Word } from "../epub/types";
import { createPacingEngine } from "../pacing/from-settings";
import type { GlobalSettings } from "./types";

export interface PacingPreviewPoint {
  word: string;
  durationMs: number;
}

export interface HistogramBin {
  startMs: number;
  endMs: number;
  count: number;
}

export interface PacingPreviewData {
  points: PacingPreviewPoint[];
  bins: HistogramBin[];
  minMs: number;
  medianMs: number;
  p90Ms: number;
  maxMs: number;
}

const WARMUP_TEXT = `
  Reading becomes comfortable when rhythm follows meaning instead of forcing every word into an identical beat.
  Common phrases should move lightly, while unusual vocabulary receives a little more time for recognition.
  The model observes patterns as the passage unfolds and gradually adapts to the language on the page.
  A steady preview makes those small timing choices visible before the reader begins.
`;

const SAMPLE_TEXT = `
  Morning light crossed the quiet room, and the reader settled into a familiar chair.
  Simple words arrived quickly; intricate expressions lingered just long enough to remain understandable.
  Then an unexpectedly technical explanation introduced photosynthesis, interoperability, and probability.
  Would the pacing still feel natural? A brief question creates a pause, followed by a calmer sentence.

  Across a new paragraph, the cadence resumes with ordinary language and several deliberately varied word lengths.
  The preview measures each complete display interval, including punctuation and paragraph pauses.
  It is representative rather than predictive: every book develops its own vocabulary, structure, and rhythm.
`;

function wordsFromText(text: string, startIndex = 0): Word[] {
  const paragraphs = text.trim().split(/\n\s*\n/u);
  const words: Word[] = [];
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const tokens = paragraphs[paragraphIndex].trim().split(/\s+/u);
    for (const token of tokens) {
      words.push({
        text: token,
        index: startIndex + words.length,
        metadata: [{ attribute: "paragraphId", value: paragraphIndex }],
      });
    }
  }
  return words;
}

export const PACING_PREVIEW_WARMUP_WORDS = wordsFromText(WARMUP_TEXT);
export const PACING_PREVIEW_SAMPLE_WORDS = wordsFromText(
  SAMPLE_TEXT,
  PACING_PREVIEW_WARMUP_WORDS.length,
);

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

export function buildHistogram(values: number[], desiredBinCount = 12): HistogramBin[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const binCount = Math.max(1, Math.min(desiredBinCount, values.length));
  const span = Math.max(1, max - min);
  const width = span / binCount;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    startMs: min + width * index,
    endMs: index === binCount - 1 ? max : min + width * (index + 1),
    count: 0,
  }));

  for (const value of values) {
    const index = Math.min(binCount - 1, Math.floor((value - min) / width));
    bins[index].count += 1;
  }
  return bins;
}

/** Build a representative preview with a fresh copy of the production backend. */
export function buildPacingPreview(settings: GlobalSettings): PacingPreviewData {
  const engine = createPacingEngine(settings);
  const allWords = [...PACING_PREVIEW_WARMUP_WORDS, ...PACING_PREVIEW_SAMPLE_WORDS];
  const stats = {
    totalWords: allWords.length,
    avgWordLength: allWords.reduce((sum, word) => sum + word.text.length, 0) / allWords.length,
  };

  // Give adaptive models representative prior context, then record only the
  // dedicated sample. This mirrors a reader after the opening few sentences.
  engine.durations(PACING_PREVIEW_WARMUP_WORDS, stats);
  const durations = engine.durations(PACING_PREVIEW_SAMPLE_WORDS, stats);
  const points = PACING_PREVIEW_SAMPLE_WORDS.map((word, index) => ({
    word: word.text,
    durationMs: Math.max(1, Math.round(durations[index])),
  }));
  const values = points.map((point) => point.durationMs);
  const sorted = [...values].sort((a, b) => a - b);

  return {
    points,
    bins: buildHistogram(values),
    minMs: sorted[0] ?? 0,
    medianMs: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

/** A stable pseudo-random traversal used by the pulse preview. */
export function buildPreviewOrder(length: number, seed = 0x51eed): number[] {
  const order = Array.from({ length }, (_, index) => index);
  let state = seed >>> 0;
  for (let index = order.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
  }
  return order;
}
