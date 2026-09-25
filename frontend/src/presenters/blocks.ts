import type { WordStream } from "../epub/types";
import type { SemanticBlock } from "./types";

export function validateBlocks(blocks: readonly SemanticBlock[], length: number): SemanticBlock[] {
  const ids = new Set<string>();
  let end = 0;
  for (const block of blocks) {
    if (typeof block.id !== "string" || !block.id || ids.has(block.id) || typeof block.sourceRef !== "string" || !block.sourceRef ||
      !["heading", "paragraph", "post"].includes(block.kind) ||
      !Number.isSafeInteger(block.start) || !Number.isSafeInteger(block.end) ||
      block.start < end || block.end <= block.start || block.end > length ||
      (block.authorBoundary !== undefined && (!Number.isSafeInteger(block.authorBoundary) || block.authorBoundary < block.start || block.authorBoundary >= block.end)) ||
      (block.kind === "heading" && (!Number.isInteger(block.level) || block.level! < 1 || block.level! > 6))) {
      throw new Error("Invalid semantic block range or identity");
    }
    ids.add(block.id); end = block.end;
  }
  return [...blocks];
}

/** Legacy EPUB metadata supplies paragraph boundaries, never guessed headings. */
export function epubBlocks(stream: WordStream): SemanticBlock[] {
  if (stream.blocks?.length) return validateBlocks(stream.blocks, stream.words.length);
  const blocks: SemanticBlock[] = [];
  let previous = "";
  for (const word of stream.words) {
    const metadata = Object.fromEntries(word.metadata.map(entry => [entry.attribute, entry.value]));
    if (metadata.paragraphId === undefined) { previous = ""; continue; }
    const key = [metadata.spineId, metadata.chapterId, metadata.sectionId, metadata.paragraphId, metadata.blockId].join(":");
    if (key !== previous) {
      const level = Number(metadata.headingLevel);
      blocks.push({ id: `epub:${key}:${word.index}`, sourceRef: `spine:${metadata.spineId ?? 0}/block:${metadata.blockId ?? key}`,
        kind: level >= 1 && level <= 6 ? "heading" : "paragraph", level: level || undefined,
        start: word.index, end: word.index + 1 });
      previous = key;
    } else blocks[blocks.length - 1].end = word.index + 1;
  }
  return blocks;
}
