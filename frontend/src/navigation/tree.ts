// src/navigation/tree.ts
// Builds a hierarchical navigation tree from the word stream's metadata.
// The tree depth is DYNAMIC — it follows the metadata array order
// (most-important first = root level). This lets each format (EPUB, PDF,
// interactive fiction, CYOA) define its own navigation shape.

import type { Word, WordStream } from "../epub/types";

/** A node in the navigation tree. */
export interface NavNode {
  /** The metadata attribute this level represents (e.g. "chapterId"). */
  attribute: string;
  /** The value of that attribute for this node. */
  value: string | number;
  /** Display label (from chapterIndex title when available, else the value). */
  label: string;
  /** First word index covered by this node. */
  startIndex: number;
  /** Last word index covered by this node. */
  endIndex: number;
  /** Child nodes (next metadata level). */
  children: NavNode[];
}

export interface NavTree {
  /** The hierarchy attributes, root-first (from metadata order). */
  levels: string[];
  /** Root nodes (top level of the tree). */
  roots: NavNode[];
}

/**
 * Build the navigation tree from a word stream.
 *
 * The hierarchy is derived from each word's `metadata` array order:
 *   metadata[0] = root level, metadata[1] = second level, etc.
 * Words are assumed to be in reading order (sorted by index).
 *
 * @param words       the flat word stream
 * @param chapterIndex optional chapter_index for titles (matched by chapterId)
 * @param maxDepth    cap on tree depth (undefined = use all metadata levels)
 */
export function buildNavTree(
  words: Word[],
  chapterIndex?: WordStream["chapterIndex"],
  maxDepth?: number
): NavTree {
  if (words.length === 0) return { levels: [], roots: [] };

  // Determine levels from the first word's metadata (all words share the scheme).
  const levels = words[0].metadata.map((m) => m.attribute);
  const depth = maxDepth !== undefined ? Math.min(maxDepth, levels.length) : levels.length;

  // Title lookup for the chapter level.
  const titleByChapter = new Map<string | number, string>();
  for (const c of chapterIndex ?? []) titleByChapter.set(c.chapterId, c.title);

  // Build the tree by walking words in order, tracking the current path.
  const roots: NavNode[] = [];

  for (const word of words) {
    const path: Array<{ attribute: string; value: string | number }> = [];
    for (let d = 0; d < depth; d++) {
      path.push({ attribute: levels[d], value: word.metadata[d]?.value ?? 0 });
    }

    // Find the deepest existing node matching this path; extend where needed.
    let parent: NavNode[] = roots;
    let parentNode: NavNode | null = null;
    for (let d = 0; d < depth; d++) {
      const { attribute, value } = path[d];
      let node = parent.find((n) => n.value === value);
      if (!node) {
        node = {
          attribute,
          value,
          label: d === 0 ? (titleByChapter.get(value) ?? String(value)) : String(value),
          startIndex: word.index,
          endIndex: word.index,
          children: [],
        };
        parent.push(node);
      }
      node.endIndex = word.index;
      parentNode = node;
      parent = node.children;
    }
    void parentNode;
  }

  return { levels: levels.slice(0, depth), roots };
}

/**
 * Find the deepest node containing a word index.
 * Returns the path of nodes from root to the deepest match.
 */
export function findNodePath(tree: NavTree, index: number): NavNode[] {
  const path: NavNode[] = [];
  let level = tree.roots;
  for (;;) {
    const node = level.find((n) => index >= n.startIndex && index <= n.endIndex);
    if (!node) break;
    path.push(node);
    if (node.children.length === 0) break;
    level = node.children;
  }
  return path;
}