import type { Word } from "../epub/types";
import type { HtmlPresentation } from "../presentation/types";
import type { InteractionRecord, ReaderInteraction } from "./types";

export type ReaderFlowNode =
  | { kind: "word"; word: Word }
  | { kind: "presentation"; presentation: HtmlPresentation }
  | { kind: "interaction"; interaction: ReaderInteraction; record?: InteractionRecord };

/** Build a stable, inline projection of words and interaction nodes. */
export function buildReaderFlowRange(
  words: Word[],
  interactions: ReaderInteraction[] = [],
  records: InteractionRecord[] = [],
  startWord = 0,
  endWord = words.length,
  presentations: HtmlPresentation[] = [],
): ReaderFlowNode[] {
  const start = Math.max(0, startWord);
  const end = Math.min(words.length, Math.max(start, endWord));
  const recordsById = new Map(records.map((record) => [record.interactionId, record]));
  const nodes: ReaderFlowNode[] = [];
  for (let boundary = start; boundary <= end; boundary += 1) {
    for (const presentation of presentations) {
      if (presentation.boundary === boundary) {
        nodes.push({ kind: "presentation", presentation });
      }
    }
    for (const interaction of interactions) {
      if (interaction.boundary === boundary) {
        nodes.push({ kind: "interaction", interaction, record: recordsById.get(interaction.id) });
      }
    }
    if (boundary < end && words[boundary]) nodes.push({ kind: "word", word: words[boundary] });
  }
  return nodes;
}
