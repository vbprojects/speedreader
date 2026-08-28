// src/db/types.ts
// The `db` abstraction — one async interface implemented by multiple adapters
// (IndexedDB first; WASM/desktop/server later). The Library and Reader only
// depend on this interface, so storage can be swapped without touching them.

import type { WordStream, Word, ChapterEntry } from "../epub/types";
import type { InteractionRecord, ReaderInteraction } from "../interactions/types";
import type { HtmlPresentation } from "../presentation/types";
import type { EngineTrigger } from "../engine-events/types";
import type { ReaderEngineEvent } from "../engine-events/types";
import type { ReaderSettings } from "../settings/types";
import type { StoredSugarCubeSource } from "../ingestion/sugarcube/types";

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
  /** Format identifier, e.g. "epub", "pdf-ocr". */
  format: string;
  /** When the book was added (epoch ms). */
  addedAt: number;
  wordCount: number;
  chapterCount: number;
  /** Parser version used to produce the cached stream (cache invalidation). */
  parserVersion: number;
  /** Optional embedded cover art. */
  cover?: CoverImage;
  /** Non-fatal caveats reported while importing this book. */
  ingestionWarnings?: string[];
  /** Format-specific state snapshot (e.g. { totalPages: 120, lastProcessedPage: 12 }). */
  formatState?: Record<string, unknown>;
  /** True for content bundled by the application rather than imported by the user. */
  builtIn?: boolean;
  /** Revision of the bundled content used to seed this book. */
  builtInRevision?: number;
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
  /** Format-specific interactive/resumption state (e.g., page cursor, session ID). */
  formatState?: Record<string, unknown>;
  /** IDs of blocking interactions completed by this reader. */
  completedInteractionIds?: string[];
  /** Persisted responses for the interaction nodes in the cached stream. */
  interactionRecords?: InteractionRecord[];
  /** Nonblocking engine triggers already dispatched for this reader. */
  deliveredTriggerIds?: string[];
  /** Durably queued events awaiting acknowledgement by the active engine. */
  pendingEngineEvents?: ReaderEngineEvent[];
}

/** A stored stream record (full stream for now; chunked later). */
export interface StoredStream {
  bookId: string;
  stream: WordStream;
}

/** Executable interactive source kept separately from derived reader data. */
export type StoredInteractiveSource = StoredSugarCubeSource;

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

  // ---- Interactive executable sources ----
  getInteractiveSource(bookId: string): Promise<StoredInteractiveSource | null>;
  saveInteractiveSource(source: StoredInteractiveSource): Promise<void>;
  deleteInteractiveSource(bookId: string): Promise<void>;

  // ---- Streams ----
  getStream(bookId: string): Promise<WordStream | null>;
  saveStream(bookId: string, stream: WordStream): Promise<void>;
  /** Append words incrementally to an existing stream or initialize if none exists. */
  appendStreamWords(
    bookId: string,
    words: Word[],
    options?: {
      chapterUpdates?: ChapterEntry[];
      interactions?: ReaderInteraction[];
      presentations?: HtmlPresentation[];
      triggers?: EngineTrigger[];
      isComplete?: boolean;
      totalWordsExpected?: number;
    }
  ): Promise<WordStream>;

  // ---- Reader state ----
  getReaderState(bookId: string): Promise<ReaderState | null>;
  saveReaderState(state: ReaderState): Promise<void>;
  /** Atomically merge a partial update without erasing format-owned state. */
  patchReaderState(
    bookId: string,
    patch: Partial<Omit<ReaderState, "bookId">>,
  ): Promise<ReaderState | null>;
  deleteReaderState(bookId: string): Promise<void>;

  /** Atomically delete everything owned by a book, including executable source. */
  deleteBookCascade(bookId: string): Promise<void>;
}
