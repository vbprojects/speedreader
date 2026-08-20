// types.ts
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
}

export interface WordStream {
  words: Word[];
  /** Derived TOC: sorted chapter ranges. Built by scanning the words once. */
  chapterIndex: ChapterEntry[];
  /** Stream-level stats. */
  meta: {
    totalWords: number;
    avgWordLength: number;
    isDeterministic: boolean;
    /** Which metadata attribute is the "chapter" level for this format. */
    chapterAttribute: string;
  };
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