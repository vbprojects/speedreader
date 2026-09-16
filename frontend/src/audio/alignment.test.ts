import { deepEqual, equal, throws } from "node:assert/strict";
import { test } from "node:test";
import { alignWordSamples, sourcePhrase } from "./alignment";
import type { Word } from "../epub/types";

const words = (...text: string[]): Word[] => text.map((text, i) => ({ text, index: i + 10, metadata: [] }));

test("source offsets preserve numbers, contractions, hyphens, punctuation and Unicode", () => {
  const input = words("Dr.", "O’Neil", "paid", "$25", "—", "don't", "re-enter", "👋🏽.");
  const phrase = sourcePhrase(input);
  deepEqual(phrase.spans.map(s => phrase.text.slice(s.start, s.end)), input.map(w => w.text));
  deepEqual(phrase.spans.map(s => s.wordIndex), input.map(w => w.index));
  equal(phrase.text, input.map(w => w.text).join(" "));
  deepEqual(sourcePhrase([]), { text: "", spans: [] });
  throws(() => sourcePhrase([input[1], input[0]]), /contiguous/);
});

// Synthetic geometry deliberately differs from Kokoro. These tests do not claim
// that a particular frame size or decoder offset is valid for the real model.
const geometry = { samplesPerFrame: 100, sampleOffset: -50, waveformSamples: 1000 };
const input = words("$25", "—", "today.");
const mapping = [
  { wordIndex: 10, tokenStart: 1, tokenEnd: 4 }, // "twenty five dollars"
  { wordIndex: 11, tokenStart: 4, tokenEnd: 4 }, // explicitly unspoken
  { wordIndex: 12, tokenStart: 5, tokenEnd: 6 },
];
const durations = [1, 1, 2, 1, 1, 2, 1];

test("expansions retain source identity, silence gaps and decoder offset", () => {
  deepEqual(alignWordSamples(input, mapping, durations, geometry), [
    { wordIndex: 10, startSample: 50, endSample: 450 },
    { wordIndex: 11, startSample: 450, endSample: 450 },
    { wordIndex: 12, startSample: 550, endSample: 750 },
  ]);
});

test("uses durations from each synthesis instead of scaling a word-length estimate", () => {
  const faster = [1, 1, 1, 1, 1, 1, 1];
  equal(alignWordSamples(input, mapping, faster, geometry)[2].endSample, 550);
});

test("rejects missing, reordered, overlapping and out-of-bounds provenance", () => {
  throws(() => alignWordSamples(input, mapping.slice(1), durations, geometry), /Every source/);
  for (const invalid of [
    { ...mapping[1], wordIndex: 99 },
    { ...mapping[1], tokenStart: 3 },
    { ...mapping[1], tokenEnd: 100 },
    { ...mapping[1], tokenEnd: 3 },
    { ...mapping[1], tokenStart: NaN },
  ]) throws(() => alignWordSamples(input, [mapping[0], invalid, mapping[2]], durations, geometry));
});

test("rejects invalid duration geometry instead of clamping alignment to audio", () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    throws(() => alignWordSamples(input, mapping, [value, ...durations.slice(1)], geometry));
  }
  for (const invalid of [
    { ...geometry, samplesPerFrame: 0 },
    { ...geometry, samplesPerFrame: 1.5 },
    { ...geometry, sampleOffset: -101 },
    { ...geometry, sampleOffset: NaN },
    { ...geometry, waveformSamples: 749 },
  ]) throws(() => alignWordSamples(input, mapping, durations, invalid));
});
