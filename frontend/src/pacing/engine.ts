// src/pacing/engine.ts
// PacingEngine — computes display durations for words by calling a PacingFn.
// It does not hard-code any algorithm; it only wires a backend + context.

import type { PacingBackend, PacingContext, PacingProfile, StreamStats } from "./types";
import type { Word } from "../epub/types";

export interface PacingEngineOptions {
  backend: PacingBackend;
  profile: PacingProfile;
}

export class PacingEngine {
  readonly backend: PacingBackend;
  profile: PacingProfile;

  constructor(options: PacingEngineOptions) {
    this.backend = options.backend;
    this.profile = options.profile;
  }

  /** Duration (ms) for a single word, given its neighbors and stream stats. */
  duration(word: Word, neighbors: PacingContext["neighbors"], stats: StreamStats): number {
    const ctx: PacingContext = {
      profile: this.profile,
      stats,
      neighbors,
    };
    return this.backend.fn(word, ctx);
  }

  /**
   * Compute durations for a whole stream (or a slice).
   * Returns an array parallel to `words`.
   */
  durations(words: Word[], stats: StreamStats): number[] {
    return words.map((word, i) =>
      this.duration(word, { prev: words[i - 1], next: words[i + 1] }, stats)
    );
  }
}
