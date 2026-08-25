// src/ingestion/pdf/types.ts
// Small PDF.js-facing types kept local to the PDF parser. The rest of the
// ingestion pipeline only sees the format-agnostic WordStream contract.

import type { BookInfo, FileInfo } from "../types";

export interface PdfTextItemLike {
  str: string;
  dir?: string;
  transform?: number[];
  width?: number;
  height?: number;
  fontName?: string;
  hasEOL?: boolean;
}

export interface PdfTextContentLike {
  items: unknown[];
}

export interface PdfPageLike {
  getTextContent(): Promise<PdfTextContentLike>;
  cleanup?: () => void;
}

export interface PdfMetadataLike {
  info?: Record<string, unknown> | null;
  metadata?: Map<string, unknown> | Record<string, unknown> | null;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  getMetadata?: () => Promise<PdfMetadataLike>;
  getPageLabels?: () => Promise<string[] | null>;
  cleanup?: () => Promise<void> | void;
}

export type PdfAdvancedReason =
  | "image-only"
  | "multi-column"
  | "complex-layout"
  | "vertical-or-rtl"
  | "unusable-font-mapping";

export type PdfSuitability =
  | { route: "pdfjs"; reason: "simple-native-text" }
  | { route: "advanced"; reason: PdfAdvancedReason };

export class PdfAdvancedLayoutError extends Error {
  readonly suitability: Extract<PdfSuitability, { route: "advanced" }>;

  constructor(suitability: Extract<PdfSuitability, { route: "advanced" }>) {
    super(`PDF requires advanced parsing (${suitability.reason})`);
    this.name = "PdfAdvancedLayoutError";
    this.suitability = suitability;
  }
}

export interface PdfParserOptions {
  /** Number of initial pages sampled before the full parse. */
  samplePages?: number;
  /** Permit pages without text when other pages contain usable prose. */
  allowEmptyPages?: boolean;
}

export type PdfBookInfo = BookInfo & { source: FileInfo };
