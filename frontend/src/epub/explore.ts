// explore.ts
// Exploration module: load an EPUB via `epubjs` and inspect its structure.
// This is experiment_1 — we explore how epubjs exposes the EPUB's hierarchy
// (spine, navigation, per-chapter text) so we can build a deterministic parser
// that emits our flat `Word` stream.
//
// epubjs reference: https://github.com/futurepress/epub.js

import ePubImport from "epubjs";
import type { EpubStructure, Word, WordStream, ChapterEntry } from "./types";

// epubjs is a CJS module; under different bundlers/tsx its default export may
// be the constructor directly, or nested under `.default`. Normalize it.
const ePubFn = (ePubImport as unknown as { default?: unknown }).default ?? ePubImport;
const ePub = ePubFn as (data: ArrayBuffer, opts?: Record<string, unknown>) => EpubBook;

/** Minimal structural surface we use from the epubjs Book. */
interface EpubBook {
  ready: Promise<unknown>;
  loaded: {
    metadata: Promise<Record<string, any>>;
    navigation: Promise<{ toc: any[] }>;
    cover: Promise<string>;
    manifest: Promise<Record<string, { href: string; type: string; properties: string[] }>>;
  };
  spine: {
    spineItems: Array<{ idref: string; index: number; href: string }>;
    get: (i: number) => { load: (req?: unknown) => Promise<HTMLElement> };
  };
  load: (path: string) => Promise<unknown>;
  archive: {
    getBlob: (url: string, mimeType?: string) => Promise<Blob>;
  };
}

/**
 * Load an EPUB from an ArrayBuffer and return an `epubjs` Book.
 * epubjs can `open` an ArrayBuffer directly.
 */
export function openBook(data: ArrayBuffer, name = "book.epub") {
  // Passing a raw ArrayBuffer makes epubjs detect INPUT_TYPE.BINARY automatically
  // and unzip it in-memory; no XHR/network needed. Do NOT force encoding:
  // forcing "base64" would make epubjs interpret raw bytes as base64 text.
  void name;
  const book = ePub(data);
  return book;
}

/**
 * Dump the STRUCTURE of the EPUB: metadata, spine, navigation, and the
 * raw text of each spine item. This is the exploration output.
 */
export async function exploreEpub(data: ArrayBuffer): Promise<EpubStructure> {
  const book = openBook(data);
  await book.ready;

  // 1. Packaging metadata (title, author, etc.)
  const rawMetadata = await book.loaded.metadata;
  const metadata: Record<string, unknown> = { ...rawMetadata };

  // 2. Spine (reading order) — the canonical chapter order.
  const sections = book.spine.spineItems;

  const spine = sections.map((item, i) => ({
    idref: item.idref ?? String(i),
    index: item.index,
    href: item.href,
  }));

  // 3. Navigation (TOC)
  const navigation: Array<{ label: string; href: string }> = [];
  try {
    const nav = await book.loaded.navigation;
    const walk = (toc: any[]) => {
      for (const item of toc || []) {
        navigation.push({ label: item.label, href: item.href });
        if (item.subitems) walk(item.subitems);
      }
    };
    walk(nav.toc);
  } catch (e) {
    // EPUB2 or no nav — leave empty.
  }

  // 4. Word text per spine item (the chapter content).
  const pages: Array<{ chapterId: number; words: string[] }> = [];
  for (let i = 0; i < sections.length; i++) {
    try {
      const section = book.spine.get(i);
      // `section.load()` returns the HTML root ELEMENT (an <html> node), not a
      // Document, so read textContent directly rather than `.body`.
      const html = await section.load(book.load.bind(book));
      const text = (html.textContent || "").trim();
      const words = text.split(/\s+/).filter(Boolean);
      pages.push({ chapterId: i, words });
    } catch (e) {
      pages.push({ chapterId: i, words: [] });
    }
  }

  return { metadata, spine, navigation, pages };
}

/**
 * Convert the explored structure into the flat `Word` stream (Option B).
 * This is a PROPOSED mapping — the exact metadata scheme is the experiment's
 * open question, and will be validated against real EPUBs.
 *
 * For now:
 *   - chapterId   = spine index
 *   - no section/paragraph splitting yet (just chapter-level)
 */
export function toWordStream(structure: EpubStructure): WordStream {
  const words: Word[] = [];
  let index = 0;
  const chapterIndex: ChapterEntry[] = [];

  for (const page of structure.pages) {
    chapterIndex.push({
      chapterId: page.chapterId,
      title: structure.navigation[page.chapterId]?.label ?? `Chapter ${page.chapterId + 1}`,
      startIndex: index,
      endIndex: index + page.words.length - 1,
    });
    for (const text of page.words) {
      words.push({
        text,
        index: index++,
        metadata: [{ attribute: "chapterId", value: page.chapterId }],
      });
    }
  }

  const total = words.length;
  const totalLen = words.reduce((s, w) => s + w.text.length, 0);

  return {
    words,
    chapterIndex,
    meta: {
      totalWords: total,
      avgWordLength: total ? totalLen / total : 0,
      isDeterministic: true,
      chapterAttribute: "chapterId",
    },
  };
}