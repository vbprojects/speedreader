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
import JSZip from "jszip";
import { assertFileSize, assertIngestionLimit, INGESTION_LIMITS } from "./limits";

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
  /** Hard breaks waiting to be attached to the next emitted word. */
  pendingLineBreaks: number;
}

interface WalkBudget {
  nodes: number;
  words: number;
  characters: number;
}

type ZipEntryWithSizes = JSZip.JSZipObject & {
  _data?: { compressedSize?: number; uncompressedSize?: number };
};

export async function validateEpubArchive(data: ArrayBuffer): Promise<void> {
  assertFileSize(data.byteLength);
  const archive = await JSZip.loadAsync(data);
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  assertIngestionLimit(entries.length, INGESTION_LIMITS.maxEpubEntries, "EPUB archive entries");

  let expandedBytes = 0;
  for (const entry of entries as ZipEntryWithSizes[]) {
    const compressed = Number(entry._data?.compressedSize);
    const expanded = Number(entry._data?.uncompressedSize);
    assertIngestionLimit(expanded, INGESTION_LIMITS.maxEpubEntryBytes, `EPUB entry ${entry.name}`);
    if (!Number.isSafeInteger(compressed) || compressed < 0 || !Number.isSafeInteger(expanded)) {
      throw new Error(`EPUB entry ${entry.name} has invalid size metadata`);
    }
    expandedBytes += expanded;
    assertIngestionLimit(expandedBytes, INGESTION_LIMITS.maxEpubExpandedBytes, "EPUB expanded size");
    if (expanded > 0 && (compressed === 0 || expanded / compressed > INGESTION_LIMITS.maxEpubCompressionRatio)) {
      throw new Error(`EPUB entry ${entry.name} has an unsafe compression ratio`);
    }
  }
}

function boundedHeadingText(element: Element): string {
  const parts: string[] = [];
  const stack: Node[] = [element];
  let remaining = 4_096;
  let visited = 0;
  while (stack.length > 0 && remaining > 0 && visited < 10_000) {
    const node = stack.pop()!;
    visited++;
    if (node.nodeType === 3) {
      const value = (node.textContent ?? "").slice(0, remaining);
      parts.push(value);
      remaining -= value.length;
      continue;
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
  }
  return parts.join("").trim();
}

/** Iteratively walk a spine DOM with global work/output budgets. */
function walkNode(root: Node, ctx: WalkCtx, budget: WalkBudget): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    budget.nodes++;
    assertIngestionLimit(budget.nodes, INGESTION_LIMITS.maxEpubDomNodes, "EPUB DOM nodes");
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      budget.characters += text.length;
      assertIngestionLimit(budget.characters, INGESTION_LIMITS.maxEpubCharacters, "EPUB text characters");
      for (const w of text.split(/\s+/)) {
        if (!w) continue;
        budget.words++;
        assertIngestionLimit(budget.words, INGESTION_LIMITS.maxEpubWords, "EPUB words");
      ctx.words.push({
        text: w,
        index: ctx.index,
        metadata: [
          { attribute: "chapterId", value: -1 }, // filled in post-pass
          { attribute: "sectionId", value: ctx.sectionId },
          { attribute: "paragraphId", value: ctx.paragraphId },
          { attribute: "spineId", value: ctx.spineId },
        ],
        ...(ctx.pendingLineBreaks > 0
          ? { formatting: { lineBreaksBefore: ctx.pendingLineBreaks } }
          : {}),
      });
      ctx.pendingLineBreaks = 0;
      ctx.index++;
      }
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;

  // Breaks are display hints on the next real word, never paced/indexed
  // tokens. Adjacent <br> elements accumulate to preserve vertical spacing.
    if (tag === "br") {
      ctx.pendingLineBreaks = Math.min(ctx.pendingLineBreaks + 1, 1_000);
      continue;
    }

  // Record anchor BEFORE children so it points at the first word inside.
    if (el.id && !ctx.anchors.has(el.id)) {
      assertIngestionLimit(ctx.anchors.size + 1, INGESTION_LIMITS.maxEpubTocEntries, "EPUB anchors");
      ctx.anchors.set(el.id, ctx.index);
      if (HEADING_TAGS.has(tag)) ctx.anchorText.set(el.id, boundedHeadingText(el));
    }

  // Headings start a new section (and reset paragraph counter).
    if (HEADING_TAGS.has(tag)) {
      ctx.sectionId++;
      ctx.paragraphId = 0;
    }
  // Block elements start a new paragraph.
    if (BLOCK_TAGS.has(tag)) ctx.paragraphId++;
    for (let i = el.childNodes.length - 1; i >= 0; i--) stack.push(el.childNodes[i]);
  }
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
  const stack = [...(Array.isArray(nav.toc) ? nav.toc : [])].reverse();
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    if (typeof item.label === "string" && typeof item.href === "string") {
      out.push({ label: item.label.slice(0, 4_096), href: item.href.slice(0, 8_192) });
      assertIngestionLimit(out.length, INGESTION_LIMITS.maxEpubTocEntries, "EPUB TOC entries");
    }
    if (Array.isArray(item.subitems)) {
      for (let i = item.subitems.length - 1; i >= 0; i--) stack.push(item.subitems[i]);
    }
  }
  return out;
}

export class EpubParser implements Parser {
  readonly format = "epub";
  private readonly validatedArchives = new WeakSet<ArrayBuffer>();

  private async validate(file: FileInfo): Promise<void> {
    if (this.validatedArchives.has(file.data)) return;
    await validateEpubArchive(file.data);
    this.validatedArchives.add(file.data);
  }

  canParse(file: FileInfo): boolean {
    return file.extension === "epub" || file.mimeType === "application/epub+zip";
  }

  /**
   * Extract book metadata (title, author, optional cover). Falls back to the
   * filename for title/author when the package metadata is missing.
   */
  async getBookInfo(file: FileInfo): Promise<BookInfo> {
    await this.validate(file);
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
        if (blob && blob.size > 0 && blob.size <= INGESTION_LIMITS.maxEpubCoverBytes) {
          cover = { blob, mimeType: blob.type || "image/jpeg" };
        }
      }
    } catch {
      // No usable cover — leave undefined (library renders a title card).
    }

    return { title, author, cover };
  }

  async parse(file: FileInfo): Promise<WordStream> {
    await this.validate(file);
    const book = openBook(file.data);
    await book.ready;

    // 1. Flatten TOC.
    const nav = await book.loaded.navigation;
    const toc = flattenToc(nav);

    // 2. Walk each spine section → words + anchors.
    const sections = (book.spine as unknown as { spineItems: Array<{ href: string; index: number }> }).spineItems;
    assertIngestionLimit(sections.length, INGESTION_LIMITS.maxEpubSpineItems, "EPUB spine items");
    const allWords: Word[] = [];
    const sectionAnchors = new Map<number, Map<string, number>>();
    const sectionAnchorText = new Map<number, Map<string, string>>();
    const sectionStart: number[] = [];
    const budget: WalkBudget = { nodes: 0, words: 0, characters: 0 };

    for (let i = 0; i < sections.length; i++) {
      const sec = book.spine.get(i);
      const html = await sec.load(book.load.bind(book));
      const ctx: WalkCtx = {
        words: [],
        anchors: new Map(),
        anchorText: new Map(),
        index: 0,
        sectionId: 0,
        paragraphId: 0,
        spineId: i,
        pendingLineBreaks: 0,
      };
      walkNode(html, ctx, budget);
      sectionStart.push(allWords.length);
      for (const w of ctx.words) w.index += sectionStart[i]; // reindex to global
      for (const word of ctx.words) allWords.push(word);
      sectionAnchors.set(i, ctx.anchors);
      sectionAnchorText.set(i, ctx.anchorText);
    }

    // 3. Map TOC anchors (href#fragment) → global word index + clean title.
    const spineByHref = new Map(sections.map((section, index) => [section.href, index]));
    const entries: TocEntry[] = toc.map((t) => {
      const [pathPart, frag] = t.href.split("#");
      const spineIndex = spineByHref.get(pathPart) ?? -1;
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
