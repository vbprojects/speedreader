import type { WordStream } from "../epub/types";
import type { ReaderInteraction } from "../interactions/types";

/**
 * Return the unresolved blocking interaction at a consumed-word boundary.
 * Presentations are deliberately absent: display content can never gate playback.
 */
export function unresolvedInteractionAtBoundary(
  stream: WordStream,
  boundary: number,
  resolvedIds: { has(id: string): boolean },
  recordedIds: { has(id: string): boolean },
): ReaderInteraction | null {
  return (stream.interactions ?? []).find(
    (interaction) =>
      interaction.boundary === boundary &&
      !resolvedIds.has(interaction.id) &&
      !recordedIds.has(interaction.id),
  ) ?? null;
}

/** Return the first unresolved interaction crossed by a forward seek. */
export function firstUnresolvedInteractionCrossed(
  stream: WordStream,
  fromIndex: number,
  toIndex: number,
  resolvedIds: { has(id: string): boolean },
  recordedIds: { has(id: string): boolean },
): ReaderInteraction | null {
  if (toIndex <= fromIndex) return null;
  return (stream.interactions ?? [])
    .filter((interaction) =>
      interaction.boundary > fromIndex &&
      interaction.boundary <= toIndex &&
      !resolvedIds.has(interaction.id) &&
      !recordedIds.has(interaction.id),
    )
    .sort((a, b) => a.boundary - b.boundary)[0] ?? null;
}
