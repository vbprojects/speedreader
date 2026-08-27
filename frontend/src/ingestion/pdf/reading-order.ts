// src/ingestion/pdf/reading-order.ts
// Conservative reading-order reconstruction for simple, text-native PDFs.
// This deliberately avoids pretending to solve arbitrary document layout;
// complex pages are routed to the future Marker/Docling service.

import type { Word } from "../../epub/types";
import type { PdfTextItemLike } from "./types";

interface PositionedItem extends PdfTextItemLike {
  x: number;
  y: number;
  fontSize: number;
  right: number;
}

export interface PdfLine {
  y: number;
  x: number;
  fontSize: number;
  text: string;
  items: PositionedItem[];
  endOfLine: boolean;
}

function isTextItem(value: unknown): value is PdfTextItemLike {
  return Boolean(value && typeof value === "object" && typeof (value as PdfTextItemLike).str === "string");
}

function cleanFragment(value: string): string {
  return value.replace(/\u00a0/g, " ").normalize("NFKC");
}

function positionedItems(items: readonly unknown[]): PositionedItem[] {
  return items
    .filter(isTextItem)
    .map((item) => {
      const transform = item.transform ?? [];
      const x = Number(transform[4] ?? 0);
      const y = Number(transform[5] ?? 0);
      const transformHeight = Math.hypot(Number(transform[1] ?? 0), Number(transform[3] ?? 0));
      const fontSize = Math.max(1, Number(item.height ?? 0), transformHeight);
      const width = Math.max(0, Number(item.width ?? 0));
      return {
        ...item,
        str: cleanFragment(item.str),
        x,
        y,
        fontSize,
        right: x + width,
      };
    })
    .filter((item) => item.str.length > 0);
}

function lineText(items: PositionedItem[]): string {
  let text = "";
  let previous: PositionedItem | undefined;

  for (const item of items) {
    const fragment = item.str;
    if (!text) {
      text = fragment.trimStart();
      previous = item;
      continue;
    }

    const hasExplicitSpace = /\s$/.test(text) || /^\s/.test(fragment);
    const geometricGap = previous ? item.x - previous.right : 0;
    const needsInferredSpace = geometricGap > Math.max(1, item.fontSize * 0.12);
    if (!hasExplicitSpace && needsInferredSpace) text += " ";
    text += fragment;
    previous = item;
  }

  return text.replace(/\s+/g, " ").trim();
}

/** Group PDF.js text runs into visual lines, preserving simple LTR order. */
export function reconstructLines(items: readonly unknown[]): PdfLine[] {
  const positioned = positionedItems(items).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Array<{ y: number; fontSize: number; items: PositionedItem[] }> = [];

  for (const item of positioned) {
    const tolerance = Math.max(2, item.fontSize * 0.45);
    // Items are y-sorted, so only the most recently created visual line can
    // match. This avoids quadratic scans for PDFs with many one-item lines.
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - item.y) <= tolerance) {
      line.items.push(item);
      line.fontSize = Math.max(line.fontSize, item.fontSize);
    } else {
      lines.push({ y: item.y, fontSize: item.fontSize, items: [item] });
    }
  }

  return lines
    .map((line) => {
      const sorted = [...line.items].sort((a, b) => a.x - b.x);
      return {
        y: line.y,
        x: sorted[0]?.x ?? 0,
        fontSize: line.fontSize,
        text: lineText(sorted),
        items: sorted,
        endOfLine: sorted.some((item) => item.hasEOL === true),
      };
    })
    .filter((line) => line.text.length > 0);
}

/** Detect the obvious two-flow layout that the local parser intentionally avoids. */
export function looksLikeMultiColumn(lines: readonly PdfLine[]): boolean {
  for (const line of lines) {
    if (line.items.length < 2) continue;
    for (let i = 1; i < line.items.length; i++) {
      const left = line.items[i - 1];
      const right = line.items[i];
      const gap = right.x - left.right;
      if (gap > Math.max(48, line.fontSize * 8) && left.str.trim().length >= 3 && right.str.trim().length >= 3) {
        return true;
      }
    }
  }
  return false;
}

function paragraphBreak(previous: PdfLine, current: PdfLine): boolean {
  const verticalGap = previous.y - current.y;
  return verticalGap > Math.max(18, previous.fontSize * 1.55);
}

function canJoinHyphenated(previous: string, current: string): boolean {
  return /[\p{L}]-$/u.test(previous) && /^[\p{Ll}]/u.test(current);
}

/** Convert one simple PDF page into format-agnostic words. */
export function extractPageWords(
  items: readonly unknown[],
  pageNumber: number,
  pageLabel: string | number = pageNumber
): Word[] {
  const lines = reconstructLines(items);
  const prepared: Array<{ text: string; paragraphBreak: boolean }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const previous = prepared[prepared.length - 1];
    const isBreak = i > 0 && paragraphBreak(lines[i - 1], line);

    if (previous && !isBreak && canJoinHyphenated(previous.text, line.text)) {
      previous.text = `${previous.text.slice(0, -1)}${line.text}`;
      continue;
    }

    prepared.push({ text: line.text, paragraphBreak: isBreak });
  }

  const words: Word[] = [];
  let paragraphId = 0;
  for (const line of prepared) {
    if (line.paragraphBreak) paragraphId++;
    for (const text of line.text.split(/\s+/u)) {
      const word = text.trim();
      if (!word) continue;
      words.push({
        text: word,
        index: words.length,
        metadata: [
          { attribute: "page", value: pageLabel },
          { attribute: "paragraphId", value: `${pageNumber}:${paragraphId}` },
        ],
      });
    }
  }
  return words;
}
