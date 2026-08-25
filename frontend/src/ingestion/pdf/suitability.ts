// src/ingestion/pdf/suitability.ts
// The local PDF.js parser has a deliberately narrow contract. These helpers
// make that boundary explicit so a future Marker/Docling router can reuse it.

import { looksLikeMultiColumn, reconstructLines } from "./reading-order";
import type { PdfAdvancedReason, PdfSuitability } from "./types";

export function classifyTextItems(items: readonly unknown[]): PdfSuitability {
  const lines = reconstructLines(items);
  if (lines.some((line) => line.items.some((item) => item.dir === "ttb" || item.dir === "rtl"))) {
    return { route: "advanced", reason: "vertical-or-rtl" };
  }
  const meaningfulCharacters = lines.reduce(
    (total, line) => total + (line.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0),
    0
  );

  if (meaningfulCharacters < 20) {
    return { route: "advanced", reason: "image-only" };
  }
  if (lines.some((line) => line.text.includes("\uFFFD"))) {
    return { route: "advanced", reason: "unusable-font-mapping" };
  }
  if (looksLikeMultiColumn(lines)) {
    return { route: "advanced", reason: "multi-column" };
  }
  return { route: "pdfjs", reason: "simple-native-text" };
}

export function advancedReasonMessage(reason: PdfAdvancedReason): string {
  switch (reason) {
    case "image-only":
      return "This PDF has no usable text layer and requires OCR.";
    case "multi-column":
      return "This PDF has multiple text columns and requires advanced layout parsing.";
    case "vertical-or-rtl":
      return "This PDF uses vertical or right-to-left text and requires advanced parsing.";
    case "unusable-font-mapping":
      return "This PDF has an unusable font text mapping and requires advanced extraction.";
    case "complex-layout":
      return "This PDF contains a layout the local parser does not support.";
  }
}
