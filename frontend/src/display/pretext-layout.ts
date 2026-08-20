// src/display/pretext-layout.ts
// Pretext-based text measurement + canvas layout for the RSVP display (Option B).
//
// Option B: render the visible window as a SINGLE scrolling line to a <canvas>,
// translating so the current word is dead-center. Pretext measures exact glyph
// widths using the browser's own font engine — and because we DRAW to canvas
// with that same engine, measurement and rendering match pixel-for-pixel.
//
// This eliminates the DOM/Pretext mismatch (per-span margins/padding would make
// DOM rendering diverge from Pretext's space-joined measurement).

import { prepareWithSegments, measureNaturalWidth } from "@chenglou/pretext";
import type { Word } from "../epub/types";

/** Measure the exact width of a text run (no wrapping) in px. */
export function measureTextWidth(text: string, font: string): number {
  if (!text) return 0;
  const prepared = prepareWithSegments(text, font);
  return measureNaturalWidth(prepared);
}

/** A single-line layout: the three text segments and their measured widths. */
export interface LineLayout {
  beforeText: string;
  currentText: string;
  afterText: string;
  beforeWidth: number;
  currentWidth: number;
  afterWidth: number;
  spaceWidth: number;
}

/**
 * Lay out the visible window as one line, measuring each part separately so we
 * know the exact x-offset of the current word.
 */
export function layoutLine(before: Word[], current: Word, after: Word[], font: string): LineLayout {
  const beforeText = before.map((w) => w.text).join(" ");
  const afterText = after.map((w) => w.text).join(" ");
  return {
    beforeText,
    currentText: current.text,
    afterText,
    beforeWidth: measureTextWidth(beforeText, font),
    currentWidth: measureTextWidth(current.text, font),
    afterWidth: measureTextWidth(afterText, font),
    spaceWidth: measureTextWidth(" ", font),
  };
}

/**
 * The horizontal translation (px) that centers the current word within the
 * container: container/2 - (current word's center x-offset in the line).
 */
export function centerTranslate(layout: LineLayout, containerWidth: number): number {
  const currentCenter = layout.beforeWidth + layout.spaceWidth + layout.currentWidth / 2;
  return containerWidth / 2 - currentCenter;
}

/** Total (natural) width of the single line. */
export function totalWidth(layout: LineLayout): number {
  return (
    layout.beforeWidth +
    (layout.beforeText ? layout.spaceWidth : 0) +
    layout.currentWidth +
    (layout.afterText ? layout.spaceWidth : 0) +
    layout.afterWidth
  );
}

/**
 * Find the largest font size (<= baseFontSize) where the widest word fits
 * within maxWidth. The context line may overflow (it scrolls + clips), but no
 * single word should be wider than the visible container.
 */
export function fitFontSize(
  words: Word[],
  fontFamily: string,
  maxWidth: number,
  baseFontSize: number
): number {
  if (words.length === 0) return baseFontSize;
  const longest = words.reduce((a, b) => (b.text.length > a.text.length ? b : a)).text;
  let lo = 8;
  let hi = baseFontSize;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureTextWidth(longest, `${mid}px ${fontFamily}`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}