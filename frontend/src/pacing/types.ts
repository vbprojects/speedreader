// src/pacing/types.ts
// Contracts for the pacing engine. The pacing model is a pluggable
// abstraction: a PacingFn maps a word to a display duration in ms.

import type { Word } from "../epub/types";

/** User-tunable pacing parameters. */
export interface PacingProfile {
  /** Target reading speed in words per minute. */
  wpm: number;
  /** Extra pause (ms) after a sentence-ending punctuation mark. */
  sentencePauseMs: number;
  /** Extra pause (ms) after a paragraph boundary. */
  paragraphPauseMs: number;
}

/** Stream statistics available to a PacingFn (may be partial for lazy streams). */
export interface StreamStats {
  totalWords: number;
  avgWordLength: number;
}

/** Context passed to a PacingFn for each word. */
export interface PacingContext {
  /** Target speed + pauses. */
  profile: PacingProfile;
  /** Stream stats (running estimate for lazy streams). */
  stats: StreamStats;
  /** Neighboring words for boundary detection (may be undefined at edges). */
  neighbors: { prev?: Word; next?: Word };
}

/**
 * A pacing backend: maps a word to its display duration in milliseconds.
 * The engine only calls this; it does not hard-code any algorithm.
 */
export type PacingFn = (word: Word, ctx: PacingContext) => number;

/** A named, selectable pacing backend. */
export interface PacingBackend {
  readonly name: string;
  readonly fn: PacingFn;
}
