// src/ingestion/pdf/parser.ts
// PDF.js-backed parser for simple, native-text PDFs. It intentionally returns
// a complete deterministic WordStream; advanced PDFs are rejected for the
// future Marker/Docling service rather than being silently misordered.

import type { ChapterEntry, Word, WordStream } from "../../epub/types";
import { computeMeta } from "../normalize";
import type { BookInfo, FileInfo, Parser } from "../types";
import { extractPageWords } from "./reading-order";
import { classifyTextItems } from "./suitability";
import {
  PdfAdvancedLayoutError,
  type PdfDocumentLike,
  type PdfMetadataLike,
  type PdfPageLike,
  type PdfParserOptions,
  type PdfTextItemLike,
} from "./types";

interface LoadedPdf {
  document: PdfDocumentLike;
  destroy: () => Promise<void>;
}

async function loadPdf(data: ArrayBuffer): Promise<LoadedPdf> {
  const pdfjs = await import("pdfjs-dist");

  // Vite bundles this worker URL, keeping PWA/Tauri operation offline. Node
  // callers use PDF.js's own worker fallback and never execute this branch.
  if (typeof window !== "undefined" && !pdfjs.GlobalWorkerOptions.workerSrc) {
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  }

  // PDF.js may transfer typed-array ownership to its worker, so give it a copy.
  const bytes = new Uint8Array(data.slice(0));
  const loadingTask = pdfjs.getDocument({ data: bytes });
  const document = (await loadingTask.promise) as unknown as PdfDocumentLike;
  return {
    document,
    destroy: async () => {
      await document.cleanup?.();
      await loadingTask.destroy();
    },
  };
}

function metadataValue(metadata: PdfMetadataLike | undefined, keys: string[]): string | undefined {
  const info = metadata?.info ?? {};
  const map = metadata?.metadata;
  for (const key of keys) {
    const value = info[key] ?? info[key[0].toUpperCase() + key.slice(1)];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (map instanceof Map) {
      const mapped = map.get(key) ?? map.get(`dc:${key.toLowerCase()}`);
      if (typeof mapped === "string" && mapped.trim()) return mapped.trim();
    } else if (map && typeof map === "object") {
      const mapped = (map as Record<string, unknown>)[key];
      if (typeof mapped === "string" && mapped.trim()) return mapped.trim();
    }
  }
  return undefined;
}

function pageLabel(labels: string[] | null | undefined, pageNumber: number): string {
  return labels?.[pageNumber - 1] || String(pageNumber);
}

async function textItems(page: PdfPageLike): Promise<unknown[]> {
  const content = await page.getTextContent();
  return content.items;
}

export class PdfJsParser implements Parser {
  readonly format = "pdf";

  constructor(private readonly options: PdfParserOptions = {}) {}

  canParse(file: FileInfo): boolean {
    if (file.extension.toLowerCase() === "pdf" || file.mimeType === "application/pdf") return true;
    const signature = new Uint8Array(file.data.slice(0, 5));
    return String.fromCharCode(...signature) === "%PDF-";
  }

  async getBookInfo(file: FileInfo): Promise<BookInfo> {
    const loaded = await loadPdf(file.data);
    try {
      const metadata = await loaded.document.getMetadata?.();
      return {
        title: metadataValue(metadata, ["Title", "title"]) ?? file.name.replace(/\.[^.]+$/, ""),
        author: metadataValue(metadata, ["Author", "Creator", "author"]) ?? "Unknown author",
      };
    } finally {
      await loaded.destroy();
    }
  }

  async parse(file: FileInfo): Promise<WordStream> {
    const loaded = await loadPdf(file.data);
    try {
      const labels = await loaded.document.getPageLabels?.();
      const samplePages = Math.min(this.options.samplePages ?? 5, loaded.document.numPages);
      let usableSamplePages = 0;

      for (let pageNumber = 1; pageNumber <= samplePages; pageNumber++) {
        const page = await loaded.document.getPage(pageNumber);
        const items = await textItems(page);
        const suitability = classifyTextItems(items);
        page.cleanup?.();
        if (suitability.route === "advanced" && suitability.reason !== "image-only") {
          throw new PdfAdvancedLayoutError(suitability);
        }
        if (suitability.route === "pdfjs") usableSamplePages++;
      }

      if (usableSamplePages === 0) {
        throw new PdfAdvancedLayoutError({ route: "advanced", reason: "image-only" });
      }

      const words: Word[] = [];
      const chapters: ChapterEntry[] = [];
      for (let pageNumber = 1; pageNumber <= loaded.document.numPages; pageNumber++) {
        const page = await loaded.document.getPage(pageNumber);
        const items = await textItems(page);
        const suitability = classifyTextItems(items);
        const label = pageLabel(labels, pageNumber);

        if (suitability.route === "advanced" && suitability.reason !== "image-only") {
          page.cleanup?.();
          throw new PdfAdvancedLayoutError(suitability);
        }

        const pageWords = extractPageWords(items as PdfTextItemLike[], pageNumber, label);
        page.cleanup?.();
        if (pageWords.length === 0) continue;

        const startIndex = words.length;
        for (const word of pageWords) {
          words.push({ ...word, index: words.length });
        }
        chapters.push({
          chapterId: `page-${pageNumber}`,
          title: `Page ${label}`,
          startIndex,
          endIndex: words.length - 1,
        });
      }

      if (words.length === 0) {
        throw new PdfAdvancedLayoutError({ route: "advanced", reason: "image-only" });
      }

      for (let i = 0; i < chapters.length; i++) {
        chapters[i].endIndex = i + 1 < chapters.length ? chapters[i + 1].startIndex - 1 : words.length - 1;
      }

      return {
        words,
        chapterIndex: chapters,
        meta: { ...computeMeta(words), chapterAttribute: "page" },
      };
    } finally {
      await loaded.destroy();
    }
  }
}

export { PdfAdvancedLayoutError } from "./types";
