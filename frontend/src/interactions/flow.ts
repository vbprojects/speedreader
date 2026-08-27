import type { Word } from "../epub/types";
import type { HtmlPresentation } from "../presentation/types";
import type { InteractionRecord, ReaderInteraction } from "./types";

export type ReaderFlowNode =
  | { kind: "word"; word: Word }
  | { kind: "presentation"; presentation: HtmlPresentation }
  | { kind: "interaction"; interaction: ReaderInteraction; record?: InteractionRecord };

function firstBoundaryAtOrAfter<T extends { boundary: number }>(items: readonly T[], boundary: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (items[middle].boundary < boundary) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Build a stable, inline projection of words and interaction nodes. */
export function buildReaderFlowRange(
  words: Word[],
  interactions: ReaderInteraction[] = [],
  records: InteractionRecord[] | ReadonlyMap<string, InteractionRecord> = [],
  startWord = 0,
  endWord = words.length,
  presentations: HtmlPresentation[] = [],
): ReaderFlowNode[] {
  const start = Math.max(0, startWord);
  const end = Math.min(words.length, Math.max(start, endWord));
  const recordsById = Array.isArray(records)
    ? new Map(records.map((record) => [record.interactionId, record]))
    : records;
  const nodes: ReaderFlowNode[] = [];
  // Validated streams keep both arrays boundary-sorted. Binary-searching the
  // visible range prevents live history from being rescanned per boundary.
  let presentationIndex = firstBoundaryAtOrAfter(presentations, start);
  let interactionIndex = firstBoundaryAtOrAfter(interactions, start);
  for (let boundary = start; boundary <= end; boundary += 1) {
    while (presentations[presentationIndex]?.boundary === boundary) {
      nodes.push({ kind: "presentation", presentation: presentations[presentationIndex] });
      presentationIndex++;
    }
    while (interactions[interactionIndex]?.boundary === boundary) {
      const interaction = interactions[interactionIndex];
      nodes.push({ kind: "interaction", interaction, record: recordsById.get(interaction.id) });
      interactionIndex++;
    }
    if (boundary < end && words[boundary]) nodes.push({ kind: "word", word: words[boundary] });
  }
  return nodes;
}
