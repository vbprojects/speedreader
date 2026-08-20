// src/ingestion/normalize.ts
// Pure, shared normalization helpers used by all parsers.
// These are deterministic and format-agnostic — parsers do format-specific
// extraction, then call these to build the flat WordStream.

import type { Word, ChapterEntry, WordStream } from "./types";

/** A TOC entry with a resolvable start index (already mapped to a word index). */
export interface TocEntry {
  label: string;
  href: string;
  startIndex: number;
}

/**
 * Build the chapter_index from TOC entries sorted by start index.
 * Each chapter's endIndex = next chapter's startIndex - 1 (last = stream end).
 */
export function buildChapterIndex(
  entries: TocEntry[],
  totalWords: number
): ChapterEntry[] {
  const sorted = [...entries].sort((a, b) => a.startIndex - b.startIndex);
  return sorted.map((e, i) => {
    const endIndex =
      i + 1 < sorted.length ? sorted[i + 1].startIndex - 1 : totalWords - 1;
    return {
      chapterId: i,
      title: e.label,
      startIndex: e.startIndex,
      endIndex: Math.max(e.startIndex, endIndex),
    };
  });
}

/**
 * Assign the chapterId metadata to every word by sweeping the chapter ranges.
 * Assumes words are in reading order and chapterIndex is sorted by startIndex.
 */
export function assignChapterIds(
  words: Word[],
  chapterIndex: ChapterEntry[]
): void {
  let ci = 0;
  for (let i = 0; i < words.length; i++) {
    while (ci < chapterIndex.length - 1 && i >= chapterIndex[ci + 1].startIndex) {
      ci++;
    }
    // chapterId is the FIRST metadata attribute (hierarchy root).
    words[i].metadata[0] = { attribute: "chapterId", value: ci };
  }
}

/** Compute stream-level stats. */
export function computeMeta(words: Word[]): WordStream["meta"] {
  const total = words.length;
  const totalLen = words.reduce((s, w) => s + w.text.length, 0);
  return {
    totalWords: total,
    avgWordLength: total ? totalLen / total : 0,
    isDeterministic: true,
    chapterAttribute: "chapterId",
  };
}
