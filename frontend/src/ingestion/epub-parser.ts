// src/ingestion/epub-parser.ts
// EpubParser — implements the Parser contract for EPUB files.
// Promotes the validated logic from experiments/toc-stream.mts:
//   - flatten TOC (chapters from nav, not spine files)
//   - walk each spine section's DOM → words tagged with
//     [chapterId, sectionId, paragraphId, spineId] (hierarchy order)
//   - map TOC anchors (href#fragment) → word indices
//   - build chapter_index + assign chapterIds via shared normalize helpers

import type { FileInfo, Parser, Word, WordStream, BookInfo } from "./types";
import { buildChapterIndex, assignChapterIds, computeMeta, type TocEntry } from "./normalize";
import { openBook } from "../epub/explore";

const BLOCK_TAGS = new Set(["p", "li", "div", "blockquote", "td", "th", "pre", "section", "article", "figcaption", "dt", "dd"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const SKIP_TAGS = new Set(["script", "style", "nav", "head", "title", "svg", "math", "noscript"]);

interface WalkCtx {
  words: Word[];
  anchors: Map<string, number>; // element id -> word index (local to section)
  anchorText: Map<string, string>; // element id -> element textContent (for titles)
  index: number;
  sectionId: number;
  paragraphId: number;
  spineId: number;
}

/** Recursively walk a spine section's DOM, emitting words with section/paragraph ids. */
function walkNode(node: Node, ctx: WalkCtx): void {
  if (node.nodeType === 3) {
    // TEXT_NODE
    const text = node.textContent ?? "";
    for (const w of text.split(/\s+/).filter(Boolean)) {
      ctx.words.push({
        text: w,
        index: ctx.index,
        metadata: [
          { attribute: "chapterId", value: -1 }, // filled in post-pass
          { attribute: "sectionId", value: ctx.sectionId },
          { attribute: "paragraphId", value: ctx.paragraphId },
          { attribute: "spineId", value: ctx.spineId },
        ],
      });
      ctx.index++;
    }
    return;
  }
  if (node.nodeType !== 1) return; // ELEMENT_NODE
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return;

  // Record anchor BEFORE children so it points at the first word inside.
  if (el.id && !ctx.anchors.has(el.id)) {
    ctx.anchors.set(el.id, ctx.index);
    ctx.anchorText.set(el.id, (el.textContent ?? "").trim());
  }

  // Headings start a new section (and reset paragraph counter).
  if (HEADING_TAGS.has(tag)) {
    ctx.sectionId++;
    ctx.paragraphId = 0;
  }
  // Block elements start a new paragraph.
  if (BLOCK_TAGS.has(tag)) ctx.paragraphId++;

  for (const child of el.childNodes) walkNode(child, ctx);
}

/**
 * Clean a chapter title from an anchor element's text.
 * Gutenberg EPUBs put an epigraph (caption) + the real chapter name in the
 * same heading element. The real name is the LAST non-empty text line, but
 * only when it looks like a chapter heading (e.g. "CHAPTER II.").
 * Otherwise (book titles, single-line headings) keep the whole text.
 * Falls back to the TOC label if no element text is available.
 */
const CHAPTER_LIKE = /^(chapter|ch\.?)\s+[0-9ivxlcdm]+\.?$/i;

export function cleanChapterTitle(elementText: string | undefined, tocLabel: string): string {
  if (elementText) {
    const lines = elementText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines.length > 1) {
      const last = lines[lines.length - 1];
      // Only use the last line if it looks like a chapter heading.
      if (last && CHAPTER_LIKE.test(last)) return last;
    }
    // Single line, or last line isn't chapter-like — fall back to the TOC
    // label (the publisher's authoritative name, e.g. the book title).
    return tocLabel;
  }
  return tocLabel;
}

/** Flatten the TOC (subitems → one level for M1). */
function flattenToc(nav: { toc: any[] }): Array<{ label: string; href: string }> {
  const out: Array<{ label: string; href: string }> = [];
  const walk = (items: any[]) => {
    for (const it of items ?? []) {
      out.push({ label: it.label, href: it.href });
      if (it.subitems) walk(it.subitems);
    }
  };
  walk(nav.toc);
  return out;
}

export class EpubParser implements Parser {
  readonly format = "epub";

  canParse(file: FileInfo): boolean {
    return file.extension === "epub" || file.mimeType === "application/epub+zip";
  }

  /**
   * Extract book metadata (title, author, optional cover). Falls back to the
   * filename for title/author when the package metadata is missing.
   */
  async getBookInfo(file: FileInfo): Promise<BookInfo> {
    const book = openBook(file.data);
    await book.ready;

    const raw = await book.loaded.metadata;
    const title = (raw.title as string)?.trim() || file.name.replace(/\.epub$/i, "");
    const author = (raw.creator as string)?.trim() || "Unknown author";

    let cover: BookInfo["cover"];
    try {
      const coverPath = await book.loaded.cover;
      if (coverPath) {
        const blob = await book.archive.getBlob(coverPath);
        if (blob && blob.size > 0) {
          cover = { blob, mimeType: blob.type || "image/jpeg" };
        }
      }
    } catch {
      // No usable cover — leave undefined (library renders a title card).
    }

    return { title, author, cover };
  }

  async parse(file: FileInfo): Promise<WordStream> {
    const book = openBook(file.data);
    await book.ready;

    // 1. Flatten TOC.
    const nav = await book.loaded.navigation;
    const toc = flattenToc(nav);

    // 2. Walk each spine section → words + anchors.
    const sections = (book.spine as unknown as { spineItems: Array<{ href: string; index: number }> }).spineItems;
    const allWords: Word[] = [];
    const sectionAnchors = new Map<number, Map<string, number>>();
    const sectionAnchorText = new Map<number, Map<string, string>>();
    const sectionStart: number[] = [];

    for (let i = 0; i < sections.length; i++) {
      const sec = book.spine.get(i);
      const html = await sec.load(book.load.bind(book));
      const ctx: WalkCtx = { words: [], anchors: new Map(), anchorText: new Map(), index: 0, sectionId: 0, paragraphId: 0, spineId: i };
      walkNode(html, ctx);
      sectionStart.push(allWords.length);
      for (const w of ctx.words) w.index += sectionStart[i]; // reindex to global
      allWords.push(...ctx.words);
      sectionAnchors.set(i, ctx.anchors);
      sectionAnchorText.set(i, ctx.anchorText);
    }

    // 3. Map TOC anchors (href#fragment) → global word index + clean title.
    const entries: TocEntry[] = toc.map((t) => {
      const [pathPart, frag] = t.href.split("#");
      const spineIndex = sections.findIndex((s) => s.href === pathPart);
      let startIndex = -1;
      let title = t.label;
      if (spineIndex >= 0) {
        const anchors = sectionAnchors.get(spineIndex)!;
        if (frag && anchors.has(frag)) {
          startIndex = sectionStart[spineIndex] + anchors.get(frag)!;
          title = cleanChapterTitle(sectionAnchorText.get(spineIndex)?.get(frag), t.label);
        } else {
          startIndex = sectionStart[spineIndex]; // fallback: section start
        }
      }
      return { label: title, href: t.href, startIndex };
    }).filter((e) => e.startIndex >= 0);

    // 4. Build chapter_index + assign chapterIds.
    const chapterIndex = buildChapterIndex(entries, allWords.length);
    assignChapterIds(allWords, chapterIndex);

    return {
      words: allWords,
      chapterIndex,
      meta: computeMeta(allWords),
    };
  }
}
