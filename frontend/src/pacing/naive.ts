// src/pacing/naive.ts
// Naive pacing backend: every word gets the SAME base duration derived from
// WPM — no adjustment for character count. Only adds fixed pauses at
// sentence and paragraph boundaries.

import type { PacingBackend, PacingFn } from "./types";
import type { Word } from "../epub/types";

const SENTENCE_END = /[.!?…]$/;

/** Base duration for a single word at the given WPM (ms). */
export function baseDurationMs(wpm: number): number {
  return (60 / wpm) * 1000;
}

/** Read a metadata attribute value from a word (or undefined). */
function metaValue(word: Word, attribute: string): string | number | undefined {
  return word.metadata.find((m) => m.attribute === attribute)?.value;
}

/** True if the next word starts a new paragraph (different paragraphId). */
function isParagraphBoundary(word: Word, next?: Word): boolean {
  if (!next) return false;
  const a = metaValue(word, "paragraphId");
  const b = metaValue(next, "paragraphId");
  return a !== undefined && b !== undefined && a !== b;
}

const naiveFn: PacingFn = (word, ctx) => {
  let duration = baseDurationMs(ctx.profile.wpm);

  // Sentence-ending punctuation → extra pause.
  if (SENTENCE_END.test(word.text)) {
    duration += ctx.profile.sentencePauseMs;
  }

  // Paragraph boundary (next word is in a different paragraph) → extra pause.
  if (isParagraphBoundary(word, ctx.neighbors.next)) {
    duration += ctx.profile.paragraphPauseMs;
  }

  return duration;
};

export const naiveBackend: PacingBackend = {
  name: "naive",
  fn: naiveFn,
};
