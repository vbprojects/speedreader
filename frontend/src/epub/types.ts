// types.ts

import type { ReaderInteraction } from "../interactions/types";
import type { HtmlPresentation } from "../presentation/types";
// Shared types matching the plan's flexible `Word` model (Option B).

/**
 * A single structural attribute attached to a word.
 * The ORDER of metadata entries defines the hierarchy:
 *   e.g. [{attribute:"chapterId",value:0},{attribute:"sectionId",value:0}]
 *        = "chapter 0, section 0"
 */
export interface Metadata {
  attribute: string;
  value: string | number;
}

/** Lightweight presentation hints that do not participate in word indexing. */
export interface WordFormatting {
  /** Number of author-intended hard line breaks immediately before this word. */
  lineBreaksBefore?: number;
  /** Number of author-intended hard line breaks immediately after this word. */
  lineBreaksAfter?: number;
  /** @deprecated Compatibility with streams created before line-break counts. */
  breakBefore?: "line";
}

/**
 * A single word in the flat stream.
 *
 * NOTE: This interface is intentionally format-agnostic and CAN change —
 * the exact metadata scheme is an open design question (see plan open Q #13)
 * to be settled empirically during EPUB ingestion work.
 */
export interface Word {
  text: string;
  index: number;
  metadata: Metadata[];
  /** Optional display-only formatting; omitted for ordinary words. */
  formatting?: WordFormatting;
}

export interface StreamMeta {
  totalWords: number;
  avgWordLength: number;
  isDeterministic: boolean;
  /** Whether the stream is completely ingested/generated. Defaults to true for deterministic one-shot parsers. */
  isComplete?: boolean;
  /** Estimated or known expected word count (if available during streaming). */
  totalWordsExpected?: number;
  /** Which metadata attribute is the "chapter" level for this format. */
  chapterAttribute: string;
  /** Non-fatal caveats produced during ingestion, shown to the reader. */
  ingestionWarnings?: string[];
}

export interface WordStream {
  words: Word[];
  /** Derived TOC: sorted chapter ranges. Built by scanning the words once. */
  chapterIndex: ChapterEntry[];
  /** Stream-level stats. */
  meta: StreamMeta;
  /** Blocking, JSON-serializable UI events keyed to word boundaries. */
  interactions?: ReaderInteraction[];
  /** Inert, optional display content keyed to word boundaries. */
  presentations?: HtmlPresentation[];
}

export interface ChapterEntry {
  chapterId: string | number;
  title: string;
  startIndex: number;
  endIndex: number;
}

/** The EPUB Surface-level structure dump from epubjs. */
export interface EpubStructure {
  metadata: Record<string, unknown>;
  spine: Array<{ idref: string; index: number; href?: string }>;
  navigation: Array<{ label: string; href: string }>;
  pages: Array<{ chapterId: number; words: string[] }>;
}
