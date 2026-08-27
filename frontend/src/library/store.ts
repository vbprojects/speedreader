// src/library/store.ts
// LibraryStore — coordinates import (hash → ingest → metadata → persist),
// listing, opening (cached rehydrate), and removal. Backed by the `db`
// abstraction (IndexedDB adapter). The Library UI depends only on this.

import type { Db, Book, ReaderState } from "../db/types";
import type { FileInfo, IngestionEngine } from "../ingestion";
import { sha256 } from "./hash";
import type { ImportResult, OpenableBook } from "./types";
import { ACTIONS_BOOK_ID, ACTIONS_BOOK_REVISION, createActionsFixture } from "./default-books/actions";
import { BLUESKY_JETSTREAM_BOOK_ID, BLUESKY_JETSTREAM_BOOK_REVISION, createBlueskyJetstreamFixture } from "./default-books/bluesky-jetstream";
import type { InteractiveFormat } from "../ingestion/interactive";
import type { ReaderEngineEvent } from "../engine-events/types";

/** Bump when the parser output shape changes → cached streams re-ingest. */
export const PARSER_VERSION = 1;

export class LibraryStore {
  private activeFormats = new Map<string, InteractiveFormat<unknown, Record<string, unknown>>>();

  constructor(
    private db: Db,
    private engine: IngestionEngine
  ) {}

  /** List all books (metadata only). */
  async getBooks(): Promise<Book[]> {
    const books = await this.db.getBooks();
    return books.sort((a, b) => b.addedAt - a.addedAt);
  }

  /** Ensure every bundled book exists and its cached stream is repairable. */
  async ensureBuiltInBooks(): Promise<void> {
    const definitions = [
      { id: ACTIONS_BOOK_ID, revision: ACTIONS_BOOK_REVISION, create: createActionsFixture },
      { id: BLUESKY_JETSTREAM_BOOK_ID, revision: BLUESKY_JETSTREAM_BOOK_REVISION, create: createBlueskyJetstreamFixture },
    ];
    for (const definition of definitions) {
      const fixture = definition.create();
      const existing = await this.db.getBook(definition.id);
      const stream = await this.db.getStream(definition.id);
      if (!existing || !existing.builtIn || existing.builtInRevision !== definition.revision) {
        await this.db.addBook({ ...fixture.book, addedAt: existing?.addedAt ?? fixture.book.addedAt });
        await this.db.saveStream(definition.id, fixture.stream);
        continue;
      }
      if (!stream) {
        await this.db.saveStream(definition.id, fixture.stream);
        await this.db.updateBook(definition.id, {
          wordCount: fixture.book.wordCount,
          chapterCount: fixture.book.chapterCount,
          parserVersion: fixture.book.parserVersion,
        });
      }
    }
  }

  /** Start a live book and serialize its chunks through persistent storage. */
  async startStreamingBook(
    bookId: string,
    onStream: (stream: import("../epub/types").WordStream) => void,
    onError: (error: Error) => void,
    initialReadPosition = 0,
  ): Promise<() => void> {
    const book = await this.db.getBook(bookId);
    const stream = await this.db.getStream(bookId);
    if (!book || !stream) throw new Error("Live book is missing from the library");
    const format = this.engine.interactiveFormatFor(book.format);
    if (!format) return () => undefined;
    this.activeFormats.set(bookId, format);
    const init = await format.init(
      { hideSelfLabeledSensitivePosts: true },
      book.formatState as Record<string, unknown> | undefined,
    );
    let disposed = false;
    let writeQueue = Promise.resolve();
    // Streams cached before engine triggers existed need one bootstrap pull at
    // their current tail so the engine can add its first wake boundary.
    const engineReadPosition = stream.triggers?.length ? initialReadPosition : stream.words.length;
    const stop = format.startStreaming(
      stream.words.length,
      (chunk) => {
        writeQueue = writeQueue.then(async () => {
          if (disposed) return;
          if (chunk.words.length === 0 && !chunk.chapterUpdates?.length && !chunk.interactions?.length && !chunk.presentations?.length && !chunk.triggers?.length) {
            await this.db.updateBook(bookId, { formatState: chunk.state });
            return;
          }
          const updated = await this.appendWords(bookId, chunk.words, {
            chapterUpdates: chunk.chapterUpdates,
            interactions: chunk.interactions,
            presentations: chunk.presentations,
            triggers: chunk.triggers,
            isComplete: chunk.isComplete,
            totalWordsExpected: chunk.totalWordsExpected,
            formatState: chunk.state,
          });
          if (!disposed) onStream(updated);
        }).catch((error: unknown) => onError(error instanceof Error ? error : new Error(String(error))));
      },
      onError,
      engineReadPosition,
    );
    if (JSON.stringify(init.initialState) !== JSON.stringify(book.formatState ?? {})) {
      await this.db.updateBook(bookId, { formatState: init.initialState });
    }
    return () => {
      disposed = true;
      stop();
      if (this.activeFormats.get(bookId) === format) this.activeFormats.delete(bookId);
    };
  }

  /** Deliver a durable reader event to the active format session. */
  async handleReaderEngineEvent(bookId: string, event: ReaderEngineEvent): Promise<void> {
    const format = this.activeFormats.get(bookId);
    // Static books may use local interactions with no owning engine.
    if (!format?.handleReaderEvent) {
      if (event.kind === "interaction-response") return;
      throw new Error("Book ingestion engine is not active");
    }
    await format.handleReaderEvent(event);
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
      interactions?: import("../interactions/types").ReaderInteraction[];
      presentations?: import("../presentation/types").HtmlPresentation[];
      triggers?: import("../engine-events/types").EngineTrigger[];
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
    let book = await this.db.getBook(bookId);
    if (!book) return null;
    let stream = await this.db.getStream(bookId);

    // Actions is a tiny bundled fixture. Rehydrate it on open so a stale PWA,
    // hot-reload session, or previously cached stream cannot silently omit new
    // stream fields such as formatting. Reader state is stored separately.
    if (bookId === ACTIONS_BOOK_ID && book.builtIn) {
      const fixture = createActionsFixture(book.addedAt);
      book = fixture.book;
      stream = fixture.stream;
      await this.db.addBook(book);
      await this.db.saveStream(bookId, stream);
    }

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
    const book = await this.db.getBook(bookId);
    if (book?.builtIn) throw new Error("Built-in books cannot be removed");
    await this.db.deleteBookCascade(bookId);
  }

  /** Clear only reader progress for a bundled demonstration book. */
  async resetReaderState(bookId: string): Promise<void> {
    const book = await this.db.getBook(bookId);
    if (!book?.builtIn) throw new Error("Only built-in books can be restarted");
    if (bookId === ACTIONS_BOOK_ID) {
      const fixture = createActionsFixture(book.addedAt);
      await this.db.saveStream(bookId, fixture.stream);
      await this.db.updateBook(bookId, {
        wordCount: fixture.book.wordCount,
        chapterCount: fixture.book.chapterCount,
        parserVersion: fixture.book.parserVersion,
        builtInRevision: fixture.book.builtInRevision,
      });
    } else if (bookId === BLUESKY_JETSTREAM_BOOK_ID) {
      const fixture = createBlueskyJetstreamFixture(book.addedAt);
      await this.db.saveStream(bookId, fixture.stream);
      await this.db.updateBook(bookId, {
        wordCount: 0,
        chapterCount: 0,
        formatState: fixture.book.formatState,
      });
    }
    await this.db.deleteReaderState(bookId);
  }
}
