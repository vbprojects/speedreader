// src/display/renderer.ts
// Renderer: given a word index, stream, and config, produce the DisplayFrame
// (current word + surrounding context window). Pure and testable.

import type { Word } from "../epub/types";
import type { DisplayConfig, DisplayFrame } from "./types";

/** Compute the adaptive window size for a given WPM. */
export function adaptiveWindow(wpm: number, base: number): number {
  // Shrink the window as WPM rises (reduce distraction at high speed).
  const scale = Math.max(0.5, Math.min(1, 300 / wpm));
  return Math.max(1, Math.round(base * scale));
}

/** Build the display frame for a word index. */
export function buildFrame(
  words: Word[],
  index: number,
  config: DisplayConfig
): DisplayFrame {
  const clamped = Math.max(0, Math.min(index, words.length - 1));
  const current = words[clamped];

  let beforeCount = config.window.before;
  let afterCount = config.window.after;
  if (config.adaptiveWindow) {
    const n = adaptiveWindow(config.wpm, Math.max(config.window.before, config.window.after));
    beforeCount = n;
    afterCount = n;
  }

  const before = words.slice(Math.max(0, clamped - beforeCount), clamped);
  const after = words.slice(clamped + 1, clamped + 1 + afterCount);

  return { current, before, after, index: clamped };
}
