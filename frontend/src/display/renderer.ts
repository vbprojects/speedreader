// src/display/renderer.ts
// Renderer: given a word index, stream, and config, produce the DisplayFrame
// (current word). Pure and testable.

import type { Word } from "../epub/types";
import type { DisplayConfig, DisplayFrame } from "./types";

/** Build the display frame for a word index. */
export function buildFrame(
  words: Word[],
  index: number,
  _config: DisplayConfig
): DisplayFrame {
  const clamped = Math.max(0, Math.min(index, words.length - 1));
  const current = words[clamped];
  return { current, index: clamped };
}
