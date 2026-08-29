/** Largest initial read-along scroll adjustment from the entry gesture. */
export const MAX_READ_ALONG_ENTRY_NUDGE_PX = 72;

/**
 * Turn the first vertical RSVP gesture into a deliberately small adjustment.
 * Later gestures are handled by ordinary native scrolling.
 */
export function readAlongEntryScrollNudge(verticalDelta: number): number {
  const nudge = -verticalDelta * 0.35;
  return Math.max(-MAX_READ_ALONG_ENTRY_NUDGE_PX, Math.min(MAX_READ_ALONG_ENTRY_NUDGE_PX, nudge));
}

/**
 * Keep the current word inside a generous reading band. Returning zero while
 * it remains in the band avoids constant per-word motion; once it leaves, the
 * requested delta places it slightly above center so upcoming text stays in
 * view.
 */
export function readAlongScrollAdjustment(
  containerTop: number,
  containerHeight: number,
  targetTop: number,
  targetHeight: number,
): number {
  if (containerHeight <= 0 || targetHeight < 0) return 0;
  const targetCenter = targetTop + targetHeight / 2;
  const bandTop = containerTop + containerHeight * 0.3;
  const bandBottom = containerTop + containerHeight * 0.7;
  if (targetCenter >= bandTop && targetCenter <= bandBottom) return 0;
  const restingLine = containerTop + containerHeight * 0.45;
  return targetCenter - restingLine;
}
