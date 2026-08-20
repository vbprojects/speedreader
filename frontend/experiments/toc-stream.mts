// toc-stream.mts
// Experiment: verify epubjs can emit a WordStream matching the spec:
//
//   metadata order (hierarchy importance, drives navigation tree):
//     1. chapterId   — index into the TOC/nav (tree root)
//     2. sectionId   — heading-delimited block (h1-h6) within chapter
//     3. paragraphId — block-level text container within section
//     4. spineId     — physical spine file index (locator, not navigation)
//
//   chapter_index built from the TOC: { chapterId, title, startIndex, endIndex }
//   where startIndex is computed by mapping each TOC anchor (href#fragment)
//   to a word index in the flat stream.
//
// Usage (from frontend/):
//   npx tsx experiments/toc-stream.mts [path.epub]

import "./dom-shim.mts";
import { readFile } from "node:fs/promises";
import { openBook } from "../src/epub/explore.ts";
import type { Word, ChapterEntry } from "../src/epub/types.ts";

const BLOCK_TAGS = new Set(["p", "li", "div", "blockquote", "td", "th", "pre", "section", "article", "figcaption", "dt", "dd"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const SKIP_TAGS = new Set(["script", "style", "nav", "head", "title", "svg", "math", "noscript"]);

interface WalkCtx {
  words: Word[];
  anchors: Map<string, number>; // element id -> word index (local to section)
  index: number;
  sectionId: number;
  paragraphId: number;
  spineId: number;
}

/** Recursively walk a spine section's DOM, emitting words with section/paragraph ids. */
function walkNode(node: Node, ctx: WalkCtx) {
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
  if (el.id) ctx.anchors.set(el.id, ctx.index);

  // Headings start a new section (and reset paragraph counter).
  if (HEADING_TAGS.has(tag)) {
    ctx.sectionId++;
    ctx.paragraphId = 0;
  }
  // Block elements start a new paragraph.
  if (BLOCK_TAGS.has(tag)) ctx.paragraphId++;

  for (const child of el.childNodes) walkNode(child, ctx);
}

interface TocEntry {
  label: string;
  href: string;
  startIndex: number;
  spineIndex: number;
}

async function main() {
  const path = process.argv[2] ?? "../epubs/prideandprejudice.epub";
  const buf = await readFile(path);
  const data = new Uint8Array(buf);
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

  const book = openBook(ab);
  await book.ready;

  // 1. Flatten the TOC (subitems -> one level for M1).
  const nav = await book.loaded.navigation;
  const toc: Array<{ label: string; href: string }> = [];
  const walkToc = (items: any[]) => {
    for (const it of items ?? []) {
      toc.push({ label: it.label, href: it.href });
      if (it.subitems) walkToc(it.subitems);
    }
  };
  walkToc(nav.toc);
  console.log(`TOC entries: ${toc.length}`);

  // 2. Walk each spine section -> words (with sectionId/paragraphId/spineId).
  const sections = (book.spine as unknown as { spineItems: Array<{ href: string; index: number }> }).spineItems;
  const allWords: Word[] = [];
  const sectionAnchors = new Map<number, Map<string, number>>();
  const sectionStart: number[] = [];

  for (let i = 0; i < sections.length; i++) {
    const sec = book.spine.get(i);
    const html = await sec.load(book.load.bind(book));
    const ctx: WalkCtx = { words: [], anchors: new Map(), index: 0, sectionId: 0, paragraphId: 0, spineId: i };
    walkNode(html, ctx);
    sectionStart.push(allWords.length);
    for (const w of ctx.words) w.index += sectionStart[i]; // reindex to global
    allWords.push(...ctx.words);
    sectionAnchors.set(i, ctx.anchors);
  }
  console.log(`Total words: ${allWords.length}`);

  // 3. Map TOC anchors (href#fragment) -> global word index.
  const entries: TocEntry[] = toc.map((t) => {
    const [pathPart, frag] = t.href.split("#");
    const spineIndex = sections.findIndex((s) => s.href === pathPart);
    let startIndex = -1;
    if (spineIndex >= 0) {
      const anchors = sectionAnchors.get(spineIndex)!;
      if (frag && anchors.has(frag)) startIndex = sectionStart[spineIndex] + anchors.get(frag)!;
      else startIndex = sectionStart[spineIndex]; // fallback: section start
    }
    return { label: t.label, href: t.href, startIndex, spineIndex };
  });

  const resolved = entries.filter((e) => e.startIndex >= 0).length;
  console.log(`TOC anchors resolved: ${resolved}/${entries.length}`);

  // 4. Sort by startIndex (TOC order should already be reading order) and build chapter_index.
  entries.sort((a, b) => a.startIndex - b.startIndex);
  const chapterIndex: ChapterEntry[] = entries.map((e, i) => {
    const endIndex = i + 1 < entries.length ? entries[i + 1].startIndex - 1 : allWords.length - 1;
    return { chapterId: i, title: e.label, startIndex: e.startIndex, endIndex: Math.max(e.startIndex, endIndex) };
  });

  // 5. Assign chapterId to every word (sweep over chapter ranges).
  let ci = 0;
  for (let i = 0; i < allWords.length; i++) {
    while (ci < chapterIndex.length - 1 && i >= chapterIndex[ci + 1].startIndex) ci++;
    allWords[i].metadata[0] = { attribute: "chapterId", value: ci };
  }

  // 6. Validate + print.
  console.log(`\nChapters: ${chapterIndex.length}`);
  console.log("First 6 chapters:");
  for (const c of chapterIndex.slice(0, 6)) {
    const first = allWords[c.startIndex];
    console.log(`  #${c.chapterId} "${c.title}" [${c.startIndex}..${c.endIndex}] firstWord="${first?.text}"`);
  }

  console.log("\nMetadata order check — first word of chapter 1:");
  console.log(JSON.stringify(allWords[chapterIndex[1].startIndex].metadata, null, 1));

  console.log("\nSample words at chapter boundaries:");
  for (const c of chapterIndex.slice(0, 3)) {
    console.log(`  ch${c.chapterId} start:`, JSON.stringify(allWords[c.startIndex]));
  }

  // Spec conformance summary
  const m = allWords[chapterIndex[1].startIndex].metadata;
  const conforms =
    m[0].attribute === "chapterId" &&
    m[1].attribute === "sectionId" &&
    m[2].attribute === "paragraphId" &&
    m[3].attribute === "spineId";
  console.log(`\n=== SPEC CONFORMANCE: ${conforms ? "PASS" : "FAIL"} ===`);
  console.log(`  metadata order: [${m.map((x) => x.attribute).join(", ")}]`);
  console.log(`  chapter_index from TOC: ${chapterIndex.length} chapters`);
  console.log(`  words: ${allWords.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});