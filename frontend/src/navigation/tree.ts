// src/navigation/tree.ts
// Builds a hierarchical navigation tree from the word stream's metadata.
// The tree depth is DYNAMIC — it follows the metadata array order
// (most-important first = root level). This lets each format (EPUB, PDF,
// interactive fiction, CYOA) define its own navigation shape.

import type { Word, WordStream } from "../epub/types";

const MAX_NAV_DEPTH = 32;
const MAX_NAV_NODES = 250_000;
interface RangeIndex {
  length: number;
  leafCount: number;
  maxEnd: number[];
}
const rangeIndexes = new WeakMap<NavNode[], RangeIndex>();

function nodeKey(attribute: string, value: string | number): string {
  return `${attribute}\u0000${typeof value}\u0000${String(value)}`;
}

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
  const requestedDepth = maxDepth !== undefined ? Math.max(0, maxDepth) : levels.length;
  const depth = Math.min(requestedDepth, levels.length, MAX_NAV_DEPTH);

  // Title lookup for the chapter level.
  const titleByChapter = new Map<string | number, string>();
  for (const c of chapterIndex ?? []) titleByChapter.set(c.chapterId, c.title);

  // Build the tree by walking words in order, tracking the current path.
  const roots: NavNode[] = [];
  const childIndexes = new WeakMap<NavNode[], Map<string, NavNode>>();
  childIndexes.set(roots, new Map());
  let nodeCount = 0;

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
      let index = childIndexes.get(parent);
      if (!index) {
        index = new Map(parent.map((node) => [nodeKey(node.attribute, node.value), node]));
        childIndexes.set(parent, index);
      }
      const key = nodeKey(attribute, value);
      let node = index.get(key);
      if (!node) {
        nodeCount++;
        if (nodeCount > MAX_NAV_NODES) throw new Error(`Navigation tree exceeds ${MAX_NAV_NODES.toLocaleString()} nodes`);
        node = {
          attribute,
          value,
          label: d === 0 ? (titleByChapter.get(value) ?? String(value)) : String(value),
          startIndex: word.index,
          endIndex: word.index,
          children: [],
        };
        parent.push(node);
        index.set(key, node);
        childIndexes.set(node.children, new Map());
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
    const node = findContainingNode(level, index);
    if (!node) break;
    path.push(node);
    if (node.children.length === 0) break;
    level = node.children;
  }
  return path;
}

function findContainingNode(nodes: NavNode[], index: number): NavNode | undefined {
  let rangeIndex = rangeIndexes.get(nodes);
  if (!rangeIndex || rangeIndex.length !== nodes.length) {
    let leafCount = 1;
    while (leafCount < nodes.length) leafCount *= 2;
    const maxEnd = new Array(leafCount * 2).fill(-Infinity);
    for (let i = 0; i < nodes.length; i++) maxEnd[leafCount + i] = nodes[i].endIndex;
    for (let i = leafCount - 1; i > 0; i--) {
      maxEnd[i] = Math.max(maxEnd[i * 2], maxEnd[i * 2 + 1]);
    }
    rangeIndex = { length: nodes.length, leafCount, maxEnd };
    rangeIndexes.set(nodes, rangeIndex);
  }

  let low = 0;
  let high = nodes.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (nodes[middle].startIndex <= index) low = middle + 1;
    else high = middle;
  }
  const candidate = firstRangeEndingAtOrAfter(rangeIndex, 1, 0, rangeIndex.leafCount, low, index);
  return candidate >= 0 ? nodes[candidate] : undefined;
}

function firstRangeEndingAtOrAfter(
  rangeIndex: RangeIndex,
  node: number,
  left: number,
  right: number,
  queryRight: number,
  index: number,
): number {
  if (left >= queryRight || rangeIndex.maxEnd[node] < index) return -1;
  if (right - left === 1) return left < rangeIndex.length ? left : -1;
  const middle = left + Math.floor((right - left) / 2);
  const first = firstRangeEndingAtOrAfter(rangeIndex, node * 2, left, middle, queryRight, index);
  return first >= 0
    ? first
    : firstRangeEndingAtOrAfter(rangeIndex, node * 2 + 1, middle, right, queryRight, index);
}
