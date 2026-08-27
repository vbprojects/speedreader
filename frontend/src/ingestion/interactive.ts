// src/ingestion/interactive.ts
// Abstract contracts and base abstractions for interactive and dynamic formats.
// Unlike one-shot batch parsers, an InteractiveFormat produces words
// asynchronously while maintaining format-specific resumption state.

import type { Word, WordStream, ChapterEntry, StreamMeta } from "../epub/types";
import type { InteractionResponse, ReaderInteraction } from "../interactions/types";
import { validateInteractions } from "../interactions/validation";
import type { HtmlPresentation } from "../presentation/types";
import { validatePresentations } from "../presentation/validation";

/** A chunk emitted by an InteractiveFormat. Boundaries in this chunk are local. */
export interface StreamChunk<TState = Record<string, unknown>> {
  /** Newly emitted words. Their indices are normalized when appended. */
  words: Word[];
  /** Optional new or updated chapter entries derived as chapters are processed. */
  chapterUpdates?: ChapterEntry[];
  /** Blocking UI events at boundaries relative to this chunk. */
  interactions?: ReaderInteraction[];
  /** Inert display nodes at boundaries relative to this chunk. */
  presentations?: HtmlPresentation[];
  /** Format-specific state snapshot at this point in the stream. */
  state: TState;
  /** True if the generation or ingestion has completed its full run. */
  isComplete: boolean;
  /** Estimated or updated total words expected, if known. */
  totalWordsExpected?: number;
}

/**
 * Abstract interface for interactive and dynamic sources.
 * The reader can use a format without knowing how its state is produced.
 */
export interface InteractiveFormat<TInput = unknown, TState = Record<string, unknown>> {
  readonly format: string;
  readonly isDeterministic: boolean;
  init(input: TInput, savedState?: TState): Promise<{
    initialState: TState;
    title?: string;
    author?: string;
  }>;
  startStreaming(
    startIndex: number,
    onChunk: (chunk: StreamChunk<TState>) => void,
    onError: (err: Error) => void
  ): () => void;
  getState(): TState;
}

/** Formats that can receive a response from the reader's interaction UI. */
export interface RespondableInteractiveFormat<
  TInput = unknown,
  TState = Record<string, unknown>,
> extends InteractiveFormat<TInput, TState> {
  submitInteraction(response: InteractionResponse): Promise<void>;
}

/**
 * Append a chunk to a WordStream, reindexing words and offsetting local
 * interaction boundaries into global word-count boundaries.
 */
export function appendToWordStream(
  stream: WordStream,
  newWords: Word[],
  options?: {
    chapterUpdates?: ChapterEntry[];
    interactions?: ReaderInteraction[];
    presentations?: HtmlPresentation[];
    isComplete?: boolean;
    totalWordsExpected?: number;
  }
): WordStream {
  const hasInteractions = (options?.interactions?.length ?? 0) > 0;
  const hasPresentations = (options?.presentations?.length ?? 0) > 0;
  if (
    newWords.length === 0 &&
    !options?.chapterUpdates &&
    !hasInteractions &&
    !hasPresentations &&
    options?.isComplete === undefined &&
    options?.totalWordsExpected === undefined
  ) {
    return stream;
  }

  const offset = stream.words.length;
  const reindexedWords = newWords.map((word, index) => ({
    ...word,
    index: offset + index,
  }));
  const mergedWords = [...stream.words, ...reindexedWords];
  const total = mergedWords.length;
  const totalLen = mergedWords.reduce((sum, word) => sum + word.text.length, 0);

  let mergedChapters = [...stream.chapterIndex];
  if (options?.chapterUpdates && options.chapterUpdates.length > 0) {
    const chapterMap = new Map<string | number, ChapterEntry>();
    for (const chapter of mergedChapters) chapterMap.set(chapter.chapterId, chapter);
    for (const chapter of options.chapterUpdates) chapterMap.set(chapter.chapterId, chapter);
    mergedChapters = Array.from(chapterMap.values()).sort((a, b) => a.startIndex - b.startIndex);
  }

  const existingInteractions = validateInteractions(stream.interactions ?? [], offset);
  const incomingInteractions = options?.interactions
    ? validateInteractions(options.interactions, newWords.length)
    : [];
  const ids = new Set(existingInteractions.map((interaction) => interaction.id));
  const mergedInteractions = [...existingInteractions];
  for (const interaction of incomingInteractions) {
    if (ids.has(interaction.id)) {
      throw new Error("duplicate interaction id: " + interaction.id);
    }
    ids.add(interaction.id);
    mergedInteractions.push({ ...interaction, boundary: interaction.boundary + offset });
  }
  mergedInteractions.sort((a, b) => a.boundary - b.boundary || a.id.localeCompare(b.id));

  const existingPresentations = validatePresentations(stream.presentations ?? [], offset);
  const incomingPresentations = options?.presentations
    ? validatePresentations(options.presentations, newWords.length)
    : [];
  const presentationIds = new Set(existingPresentations.map((presentation) => presentation.id));
  const mergedPresentations = [...existingPresentations];
  for (const presentation of incomingPresentations) {
    if (presentationIds.has(presentation.id)) {
      throw new Error("duplicate presentation id: " + presentation.id);
    }
    presentationIds.add(presentation.id);
    mergedPresentations.push({ ...presentation, boundary: presentation.boundary + offset });
  }
  mergedPresentations.sort((a, b) => a.boundary - b.boundary);

  const meta: StreamMeta = {
    ...stream.meta,
    totalWords: total,
    avgWordLength: total ? totalLen / total : 0,
    isComplete: options?.isComplete ?? stream.meta.isComplete ?? false,
    totalWordsExpected: options?.totalWordsExpected ?? stream.meta.totalWordsExpected,
  };

  return {
    words: mergedWords,
    chapterIndex: mergedChapters,
    meta,
    ...(mergedInteractions.length > 0 ? { interactions: mergedInteractions } : {}),
    ...(mergedPresentations.length > 0 ? { presentations: mergedPresentations } : {}),
  };
}
