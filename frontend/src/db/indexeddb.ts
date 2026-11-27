// src/db/indexeddb.ts
// IndexedDB adapter for the `db` interface. Offline-first, origin-local.
// Stores books, full word streams, executable interactive sources, and
// per-book reader state as structured clones. Versioned schema with an upgrade
// path.

import type { Book, CoverImage, Db, ReaderState, StoredInteractiveSource, StoredStream } from "./types";
import { appendToWordStream } from "../ingestion/interactive";

import { STORE_PUBLISHED, STORE_PUBLISHED_USAGE, STORE_PUBLISHED_BUDGET, PUBLISHED_STORES,
  loadPublished, commitPublished, getPublishedUsage, inspectPublishedRecovery, replacePublished,
  guardPublishedStateWrite, removePublishedInTransaction } from "./published-storage";

const DB_NAME = "speedreader";
const DB_VERSION = 4;

const STORE_BOOKS = "books";
const STORE_STREAMS = "streams";
const STORE_STATES = "readerStates";
const STORE_FILES = "sourceFiles";
const STORE_SOURCES = "interactiveSources";

function openDb(invalidate: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PUBLISHED)) db.createObjectStore(STORE_PUBLISHED, { keyPath: ["bookId", "area", "key"] });
      if (!db.objectStoreNames.contains(STORE_PUBLISHED_USAGE)) db.createObjectStore(STORE_PUBLISHED_USAGE, { keyPath: "bookId" });
      if (!db.objectStoreNames.contains(STORE_PUBLISHED_BUDGET)) db.createObjectStore(STORE_PUBLISHED_BUDGET, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES, { keyPath: "bookId" });
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_STREAMS)) {
        db.createObjectStore(STORE_STREAMS, { keyPath: "bookId" });
      }
      if (!db.objectStoreNames.contains(STORE_STATES)) {
        db.createObjectStore(STORE_STATES, { keyPath: "bookId" });
      }
      if (!db.objectStoreNames.contains(STORE_SOURCES)) {
        db.createObjectStore(STORE_SOURCES, { keyPath: "bookId" });
      }
    };
    req.onsuccess = () => {
      if (blocked) { req.result.close(); return; }
      req.result.onversionchange = () => { req.result.close(); invalidate(); };
      req.result.onclose = invalidate;
      resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
    req.onblocked = () => { blocked = true; reject(new Error("IndexedDB upgrade is blocked. Close other Speedreader tabs, then retry.")); };
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}

function reqResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Request failed"));
  });
}

export class IndexedDb implements Db {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDb(() => { this.dbPromise = null; }).catch(cause => { this.dbPromise = null; throw cause; });
    }
    return this.dbPromise;
  }

  async getSourceFile(bookId: string): Promise<import("./types").StoredSourceFile | null> {
    const db = await this.db();
    return (await reqResult(db.transaction(STORE_FILES, "readonly").objectStore(STORE_FILES).get(bookId))) ?? null;
  }
  async saveSourceFile(source: import("./types").StoredSourceFile): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_FILES, "readwrite");
    tx.objectStore(STORE_FILES).put(source);
    await txDone(tx);
  }
  async getBook(id: string): Promise<Book | null> {
    const db = await this.db();
    const tx = db.transaction(STORE_BOOKS, "readonly");
    const store = tx.objectStore(STORE_BOOKS);
    return (await reqResult(store.get(id))) ?? null;
  }

  async getBooks(): Promise<Book[]> {
    const db = await this.db();
    const tx = db.transaction(STORE_BOOKS, "readonly");
    const store = tx.objectStore(STORE_BOOKS);
    return await reqResult(store.getAll());
  }

  async addBook(book: Book): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_BOOKS, "readwrite");
    tx.objectStore(STORE_BOOKS).put(book);
    await txDone(tx);
  }

  async updateBook(id: string, patch: Partial<Book>): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_BOOKS, "readwrite");
      const store = tx.objectStore(STORE_BOOKS);
      const getRequest = store.get(id);
      getRequest.onerror = () => reject(getRequest.error ?? new Error("Failed to read book for update"));
      getRequest.onsuccess = () => {
        const existing = getRequest.result as Book | undefined;
        if (existing) store.put({ ...existing, ...patch, id });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Book update transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Book update transaction aborted"));
    });
  }

  async deleteBook(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_BOOKS, "readwrite");
    tx.objectStore(STORE_BOOKS).delete(id);
    await txDone(tx);
  }

  async getInteractiveSource(bookId: string): Promise<StoredInteractiveSource | null> {
    const db = await this.db();
    const tx = db.transaction(STORE_SOURCES, "readonly");
    return (await reqResult(tx.objectStore(STORE_SOURCES).get(bookId))) ?? null;
  }

  async saveInteractiveSource(source: StoredInteractiveSource): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_SOURCES, "readwrite");
    tx.objectStore(STORE_SOURCES).put(source);
    await txDone(tx);
  }

  async deleteInteractiveSource(bookId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_SOURCES, "readwrite");
    tx.objectStore(STORE_SOURCES).delete(bookId);
    await txDone(tx);
  }

  async getStream(bookId: string): Promise<import("../epub/types").WordStream | null> {
    const db = await this.db();
    const tx = db.transaction(STORE_STREAMS, "readonly");
    const store = tx.objectStore(STORE_STREAMS);
    const rec = (await reqResult(store.get(bookId))) as StoredStream | undefined;
    return rec?.stream ?? null;
  }

  async saveStream(bookId: string, stream: import("../epub/types").WordStream): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_STREAMS, "readwrite");
    tx.objectStore(STORE_STREAMS).put({ bookId, stream } satisfies StoredStream);
    await txDone(tx);
  }

  async appendStreamWords(
    bookId: string,
    newWords: import("../epub/types").Word[],
    options?: {
      blocks?: import("../presenters/types").SemanticBlock[];
    chapterUpdates?: import("../epub/types").ChapterEntry[];
      interactions?: import("../interactions/types").ReaderInteraction[];
      presentations?: import("../presentation/types").HtmlPresentation[];
      triggers?: import("../engine-events/types").EngineTrigger[];
      isComplete?: boolean;
      totalWordsExpected?: number;
    }
  ): Promise<import("../epub/types").WordStream> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_STREAMS, "readwrite");
      const store = tx.objectStore(STORE_STREAMS);
      const getRequest = store.get(bookId);
      let updatedStream: import("../epub/types").WordStream | null = null;

      getRequest.onerror = () => reject(getRequest.error ?? new Error("Failed to read stream for append"));
      getRequest.onsuccess = () => {
        try {
          const rec = getRequest.result as StoredStream | undefined;
          if (rec?.stream) {
            updatedStream = appendToWordStream(rec.stream, newWords, options);
          } else {
            updatedStream = appendToWordStream({
              words: [], chapterIndex: [],
              meta: { totalWords: 0, avgWordLength: 0, isDeterministic: false, isComplete: false, chapterAttribute: "chapterId" },
            }, newWords, options);
          }
          // Keep the read-modify-write operation inside this request callback;
          // yielding here lets IndexedDB auto-commit the transaction.
          store.put({ bookId, stream: updatedStream } satisfies StoredStream);
        } catch (error) {
          tx.abort();
          reject(error);
        }
      };
      tx.oncomplete = () => {
        if (updatedStream) resolve(updatedStream);
        else reject(new Error("Stream append completed without an updated stream"));
      };
      tx.onerror = () => reject(tx.error ?? new Error("Stream append transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Stream append transaction aborted"));
    });
  }

  async loadPublishedStorage(bookId: string, sourceHash: string) {
    return loadPublished(await this.db(), STORE_STATES, bookId, sourceHash);
  }
  async commitPublishedStorage(bookId: string, batch: import("../ingestion/sugarcube/storage-protocol").PublishedCommit) {
    return commitPublished(await this.db(), STORE_STATES, bookId, batch);
  }
  async getPublishedStorageUsage() {
    return getPublishedUsage(await this.db(), STORE_STATES);
  }
  async inspectPublishedRecovery(bookId: string, sourceHash: string) {
    return inspectPublishedRecovery(await this.db(), STORE_STATES, bookId, sourceHash);
  }
  async replacePublishedStorage(bookId: string, replacement: import("./published-storage").PublishedReplacement) {
    return replacePublished(await this.db(), STORE_STATES, bookId, replacement);
  }

  async getReaderState(bookId: string): Promise<ReaderState | null> {
    const db = await this.db();
    const tx = db.transaction(STORE_STATES, "readonly");
    const store = tx.objectStore(STORE_STATES);
    return (await reqResult(store.get(bookId))) ?? null;
  }

  async saveReaderState(state: ReaderState): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_STATES, ...PUBLISHED_STORES], "readwrite");
      const store = tx.objectStore(STORE_STATES), request = store.get(state.bookId);
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const existing = request.result as ReaderState | undefined;
          const updated = { ...state, formatState: { ...existing?.formatState, ...state.formatState } };
          const published = existing?.formatState?.published as { version?: unknown } | undefined;
          if (published?.version === 2 && updated.formatState.revision !== existing?.formatState?.revision) {
            throw new Error("Changing a story revision requires an expected revision.");
          }
          guardPublishedStateWrite(tx, existing, updated); store.put(updated);
        } catch (cause) { failure = cause; tx.abort(); }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Reader state save aborted."));
    });
  }

  async patchReaderState(
    bookId: string,
    patch: Partial<Omit<ReaderState, "bookId">>,
    expectedRevision?: string | null,
  ): Promise<ReaderState | null> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_STATES, ...PUBLISHED_STORES], "readwrite");
      const store = tx.objectStore(STORE_STATES), request = store.get(bookId);
      let updated: ReaderState | null = null, failure: unknown;
      request.onsuccess = () => {
        try {
          const existing = request.result as ReaderState | undefined;
          if (!existing) return;
          if (expectedRevision !== undefined && (existing.formatState?.revision ?? null) !== expectedRevision) {
            throw new Error("This story changed in another session. Reopen it to load the latest save.");
          }
          updated = { ...existing, ...patch, bookId };
          if (existing.formatState || patch.formatState) updated.formatState = { ...existing.formatState, ...patch.formatState };
          const published = existing.formatState?.published as { version?: unknown } | undefined;
          if (published?.version === 2 && expectedRevision === undefined && updated.formatState?.revision !== existing.formatState?.revision) {
            throw new Error("Changing a story revision requires an expected revision.");
          }
          guardPublishedStateWrite(tx, existing, updated); store.put(updated);
        } catch (cause) { failure = cause; tx.abort(); }
      };
      tx.oncomplete = () => resolve(updated);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Reader state patch aborted."));
    });
  }

  async deleteReaderState(bookId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([STORE_STATES, ...PUBLISHED_STORES], "readwrite");
    removePublishedInTransaction(tx, bookId);
    tx.objectStore(STORE_STATES).delete(bookId);
    await txDone(tx);
  }

  async deleteBookCascade(bookId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([STORE_BOOKS, STORE_STREAMS, STORE_STATES, STORE_SOURCES, STORE_FILES, ...PUBLISHED_STORES], "readwrite");
    removePublishedInTransaction(tx, bookId);
    tx.objectStore(STORE_BOOKS).delete(bookId);
    tx.objectStore(STORE_STREAMS).delete(bookId);
    tx.objectStore(STORE_STATES).delete(bookId);
    tx.objectStore(STORE_SOURCES).delete(bookId);
    tx.objectStore(STORE_FILES).delete(bookId);
    await txDone(tx);
  }
}

/** Re-export the CoverImage type for convenience. */
export type { CoverImage };
