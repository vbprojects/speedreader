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
