// src/ingestion/interactive.ts
// Abstract contracts and base abstractions for interactive and dynamic formats.
// Unlike one-shot batch parsers (such as EpubParser), an InteractiveFormat produces
// words asynchronously (e.g., page-by-page PDF OCR, LLM story generation, interactive prompts),
// maintaining format-specific resumption state while decoupling word accumulation into the stream.

import type { Word, WordStream, ChapterEntry, StreamMeta } from "../epub/types";

/**
 * A chunk of streamed data emitted by an InteractiveFormat.
 */
export interface StreamChunk<TState = Record<string, unknown>> {
  /** Newly emitted words with contiguous monotonic indices matching global stream index. */
  words: Word[];
  /** Optional new or updated chapter entries derived as chapters are processed. */
  chapterUpdates?: ChapterEntry[];
  /** Format-specific state snapshot at this point in the stream (e.g. { currentPage: 12 }). */
  state: TState;
  /** True if the generation/ingestion has completed its full run. */
  isComplete: boolean;
  /** Estimated or updated total words expected, if known. */
  totalWordsExpected?: number;
}

/**
 * Abstract interface for interactive and dynamic sources.
 * Subclasses implement domain-specific ingestion/generation logic (e.g. PdfOcrFormat, LlmInteractiveFormat).
 */
export interface InteractiveFormat<TInput = unknown, TState = Record<string, unknown>> {
  /** Format identifier (e.g., "pdf-ocr", "interactive-llm"). */
  readonly format: string;
  /** Indicates non-deterministic generation. */
  readonly isDeterministic: boolean;

  /**
   * Initialize a new interactive session or resume an existing one using saved formatState.
   */
  init(
    input: TInput,
    savedState?: TState
  ): Promise<{
    initialState: TState;
    title?: string;
    author?: string;
  }>;

  /**
   * Start or resume background stream generation/extraction.
   * Emits chunks of words via `onChunk` and errors via `onError`.
   * Returns an abort/cleanup function to pause or cancel the background process.
   */
  startStreaming(
    startIndex: number,
    onChunk: (chunk: StreamChunk<TState>) => void,
    onError: (err: Error) => void
  ): () => void;

  /**
   * Extract the current format-specific state for persistence.
   */
  getState(): TState;
}

/**
 * Helper to append a new batch of words to an existing WordStream, updating
 * indices, stream stats, chapter index, and stream metadata.
 */
export function appendToWordStream(
  stream: WordStream,
  newWords: Word[],
  options?: {
    chapterUpdates?: ChapterEntry[];
    isComplete?: boolean;
    totalWordsExpected?: number;
  }
): WordStream {
  if (newWords.length === 0 && !options?.chapterUpdates && options?.isComplete === undefined) {
    return stream;
  }

  const offset = stream.words.length;
  const reindexedWords = newWords.map((w, i) => ({
    ...w,
    index: offset + i,
  }));

  const mergedWords = [...stream.words, ...reindexedWords];
  const total = mergedWords.length;
  const totalLen = mergedWords.reduce((s, w) => s + w.text.length, 0);

  let mergedChapters = [...stream.chapterIndex];
  if (options?.chapterUpdates && options.chapterUpdates.length > 0) {
    const chapterMap = new Map<string | number, ChapterEntry>();
    for (const c of mergedChapters) chapterMap.set(c.chapterId, c);
    for (const c of options.chapterUpdates) chapterMap.set(c.chapterId, c);
    mergedChapters = Array.from(chapterMap.values()).sort((a, b) => a.startIndex - b.startIndex);
  }

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
  };
}
