// src/db/types.ts
// The `db` abstraction — one async interface implemented by multiple adapters
// (IndexedDB first; WASM/desktop/server later). The Library and Reader only
// depend on this interface, so storage can be swapped without touching them.

import type { WordStream } from "../epub/types";
import type { ReaderSettings } from "../settings/types";

/** A cover image stored with a book (browser-safe Blob). */
export interface CoverImage {
  blob: Blob;
  mimeType: string;
}

/** Library book metadata (format-agnostic). */
export interface Book {
  /** SHA-256 of the source file bytes — deterministic identity. */
  id: string;
  title: string;
  author: string;
  /** Format identifier, e.g. "epub". */
  format: string;
  /** When the book was added (epoch ms). */
  addedAt: number;
  wordCount: number;
  chapterCount: number;
  /** Parser version used to produce the cached stream (cache invalidation). */
  parserVersion: number;
  /** Optional embedded cover art. */
  cover?: CoverImage;
}

/** Durable per-book reader state (rehydrated on reopen). */
export interface ReaderState {
  bookId: string;
  /** Current word index. */
  position: number;
  /** When the book was last opened (epoch ms). */
  lastOpenedAt: number;
  /** Per-reader settings overrides (merged over global on open). */
  settings: ReaderSettings;
}

/** A stored stream record (full stream for now; chunked later). */
export interface StoredStream {
  bookId: string;
  stream: WordStream;
}

/**
 * The db interface. All methods async. Adapters implement this contract so
 * the client (IndexedDB), WASM, desktop, and server backends are swappable.
 */
export interface Db {
  // ---- Books ----
  getBook(id: string): Promise<Book | null>;
  getBooks(): Promise<Book[]>;
  addBook(book: Book): Promise<void>;
  updateBook(id: string, patch: Partial<Book>): Promise<void>;
  deleteBook(id: string): Promise<void>;

  // ---- Streams ----
  getStream(bookId: string): Promise<WordStream | null>;
  saveStream(bookId: string, stream: WordStream): Promise<void>;

  // ---- Reader state ----
  getReaderState(bookId: string): Promise<ReaderState | null>;
  saveReaderState(state: ReaderState): Promise<void>;
  deleteReaderState(bookId: string): Promise<void>;

  /** Atomically delete everything owned by a book (book + stream + state). */
  deleteBookCascade(bookId: string): Promise<void>;
}