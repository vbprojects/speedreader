// explore-chapter-names.mts
// Explore how chapter names are extracted: compare the TOC label against the
// actual text at the anchor position in the document.
//
// For each TOC entry we:
//   1. Resolve href#fragment → word index (same mapping as EpubParser).
//   2. Capture the element that carries the anchor id (tag + text).
//   3. Capture the words at that position (a window).
//   4. Compare the TOC label with the actual text.
//
// Usage (from frontend/):
//   npx tsx experiments/explore-chapter-names.mts [path.epub]

import "./dom-shim.mts";
import { readFile } from "node:fs/promises";
import { openBook } from "../src/epub/explore.ts";

const BLOCK_TAGS = new Set(["p", "li", "div", "blockquote", "td", "th", "pre", "section", "article", "figcaption", "dt", "dd"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const SKIP_TAGS = new Set(["script", "style", "nav", "head", "title", "svg", "math", "noscript"]);

interface AnchorInfo {
  id: string;
  /** Element tag carrying the id. */
  tag: string;
  /** Text content of that element (trimmed, first 80 chars). */
  elementText: string;
  /** Local word index of the anchor. */
  wordIndex: number;
}

interface WalkCtx {
  anchors: Map<string, AnchorInfo>;
  index: number;
}

function walkNode(node: Node, ctx: WalkCtx): void {
  if (node.nodeType === 3) {
    const text = node.textContent ?? "";
    ctx.index += text.split(/\s+/).filter(Boolean).length;
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return;

  if (el.id && !ctx.anchors.has(el.id)) {
    ctx.anchors.set(el.id, {
      id: el.id,
      tag,
      elementText: (el.textContent ?? "").trim().slice(0, 80),
      wordIndex: ctx.index,
    });
  }

  for (const child of el.childNodes) walkNode(child, ctx);
}

async function main() {
  const path = process.argv[2] ?? "../epubs/prideandprejudice.epub";
  const buf = await readFile(path);
  const data = new Uint8Array(buf);
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

  const book = openBook(ab);
  await book.ready;

  // 1. Flatten TOC.
  const nav = await book.loaded.navigation;
  const toc: Array<{ label: string; href: string }> = [];
  const walkToc = (items: any[]) => {
    for (const it of items ?? []) {
      toc.push({ label: it.label, href: it.href });
      if (it.subitems) walkToc(it.subitems);
    }
  };
  walkToc(nav.toc);
  console.log(`TOC entries: ${toc.length}\n`);

  // 2. Walk each spine section, collecting anchors (id → element + word index).
  const sections = (book.spine as unknown as { spineItems: Array<{ href: string; index: number }> }).spineItems;
  const sectionAnchors = new Map<number, Map<string, AnchorInfo>>();
  const sectionStart: number[] = [];

  for (let i = 0; i < sections.length; i++) {
    const sec = book.spine.get(i);
    const html = await sec.load(book.load.bind(book));
    const ctx: WalkCtx = { anchors: new Map(), index: 0 };
    walkNode(html, ctx);
    sectionStart.push(0); // placeholder; we only need relative word index
    sectionAnchors.set(i, ctx.anchors);
  }

  // 3. For each TOC entry, resolve the anchor and compare.
  let resolved = 0;
  let headingAnchors = 0;
  let labelMatchesElement = 0;

  console.log("=== TOC label vs anchor element text ===");
  for (const t of toc.slice(0, 25)) {
    const [pathPart, frag] = t.href.split("#");
    const spineIndex = sections.findIndex((s) => s.href === pathPart);
    if (spineIndex < 0) {
      console.log(`  [NO SPINE] "${t.label}" -> ${t.href}`);
      continue;
    }
    const anchors = sectionAnchors.get(spineIndex)!;
    const info = frag ? anchors.get(frag) : undefined;
    if (!info) {
      console.log(`  [NO ANCHOR] "${t.label}" -> ${t.href}`);
      continue;
    }
    resolved++;
    if (HEADING_TAGS.has(info.tag)) headingAnchors++;

    // Does the TOC label match the element text?
    const labelNorm = t.label.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    const elemNorm = info.elementText.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    const match = labelNorm === elemNorm || elemNorm.startsWith(labelNorm) || labelNorm.startsWith(elemNorm);
    if (match) labelMatchesElement++;

    console.log(`  [${info.tag}] "${t.label}"`);
    console.log(`      anchor text: "${info.elementText}"`);
    console.log(`      match: ${match ? "YES" : "NO"}`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Resolved anchors: ${resolved}/${toc.length}`);
  console.log(`Anchors on heading elements (h1-h6): ${headingAnchors}`);
  console.log(`Labels matching element text: ${labelMatchesElement}/${resolved}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});