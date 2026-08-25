// src/library/store.ts
// LibraryStore — coordinates import (hash → ingest → metadata → persist),
// listing, opening (cached rehydrate), and removal. Backed by the `db`
// abstraction (IndexedDB adapter). The Library UI depends only on this.

import type { Db, Book, ReaderState } from "../db/types";
import type { FileInfo, IngestionEngine } from "../ingestion";
import { sha256 } from "./hash";
import type { ImportResult, OpenableBook } from "./types";

/** Bump when the parser output shape changes → cached streams re-ingest. */
export const PARSER_VERSION = 1;

export class LibraryStore {
  constructor(
    private db: Db,
    private engine: IngestionEngine
  ) {}

  /** List all books (metadata only). */
  async getBooks(): Promise<Book[]> {
    const books = await this.db.getBooks();
    return books.sort((a, b) => b.addedAt - a.addedAt);
  }

  /** Import a file: hash → ingest → metadata → persist. Dedupes by hash. */
  async importFile(file: FileInfo): Promise<ImportResult> {
    const id = await sha256(file.data);

    // Dedupe: identical bytes → reuse the existing book (no duplicate tile).
    const existing = await this.db.getBook(id);
    if (existing) {
      const stream = await this.db.getStream(id);
      if (stream) return { book: existing, stream, existed: true };
      // Cached stream missing/stale — fall through and re-ingest.
    }

    const stream = await this.engine.ingest(file);

    // Extract metadata (title/author/cover) via the parser, if available.
    const parser = this.engine.parserFor(file);
    let title = file.name.replace(/\.[^.]+$/, "");
    let author = "Unknown author";
    let cover: Book["cover"];
    if (parser?.getBookInfo) {
      try {
        const info = await parser.getBookInfo(file);
        title = info.title || title;
        author = info.author || author;
        cover = info.cover;
      } catch {
        // Metadata extraction is best-effort; fall back to filename.
      }
    }

    const book: Book = {
      id,
      title,
      author,
      format: parser?.format ?? file.extension,
      addedAt: Date.now(),
      wordCount: stream.meta.totalWords,
      chapterCount: stream.chapterIndex.length,
      parserVersion: PARSER_VERSION,
      cover,
      ingestionWarnings: stream.meta.ingestionWarnings,
    };

    await this.db.addBook(book);
    await this.db.saveStream(id, stream);
    return { book, stream, existed: false };
  }

  /**
   * Append a batch of new words to a book's stream in the background, updating
   * wordCount, stream cache, and optional formatState in the database.
   */
  async appendWords(
    bookId: string,
    newWords: import("../epub/types").Word[],
    options?: {
      chapterUpdates?: import("../epub/types").ChapterEntry[];
      isComplete?: boolean;
      totalWordsExpected?: number;
      formatState?: Record<string, unknown>;
    }
  ): Promise<import("../epub/types").WordStream> {
    const updatedStream = await this.db.appendStreamWords(bookId, newWords, options);
    await this.db.updateBook(bookId, {
      wordCount: updatedStream.meta.totalWords,
      chapterCount: updatedStream.chapterIndex.length,
      formatState: options?.formatState,
    });
    return updatedStream;
  }

  /** Open a book by id: load its cached stream (no re-parse). */
  async openBook(bookId: string): Promise<OpenableBook | null> {
    const book = await this.db.getBook(bookId);
    if (!book) return null;
    const stream = await this.db.getStream(bookId);
    if (!stream) return null;
    return { book, stream };
  }

  /** Get a book's saved reader state (position + settings), if any. */
  async getReaderState(bookId: string): Promise<ReaderState | null> {
    return this.db.getReaderState(bookId);
  }

  /** Persist reader state (position + settings + lastOpenedAt). */
  async saveReaderState(state: ReaderState): Promise<void> {
    await this.db.saveReaderState(state);
  }

  /** Remove a book and all its owned data (stream + state). */
  async removeBook(bookId: string): Promise<void> {
    await this.db.deleteBookCascade(bookId);
  }
}