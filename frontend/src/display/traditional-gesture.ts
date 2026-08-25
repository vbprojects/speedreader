// src/display/traditional-gesture.ts
// Pure gesture math for entering the traditional reader without letting the
// transition gesture carry the reader far away from the highlighted word.

/** Largest initial traditional-view scroll adjustment from the entry gesture. */
export const MAX_TRADITIONAL_ENTRY_NUDGE_PX = 72;

/**
 * Translate the first vertical RSVP gesture into a deliberately small scroll
 * adjustment after the current word is centered in traditional view.
 *
 * A swipe up advances the document (positive scrollTop); a swipe down reveals
 * earlier context. Subsequent gestures use ordinary native scrolling.
 */
export function traditionalEntryScrollNudge(verticalDelta: number): number {
  const nudge = -verticalDelta * 0.35;
  return Math.max(-MAX_TRADITIONAL_ENTRY_NUDGE_PX, Math.min(MAX_TRADITIONAL_ENTRY_NUDGE_PX, nudge));
}
