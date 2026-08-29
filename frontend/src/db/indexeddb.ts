// src/db/indexeddb.ts
// IndexedDB adapter for the `db` interface. Offline-first, origin-local.
// Stores books, full word streams, executable interactive sources, and
// per-book reader state as structured clones. Versioned schema with an upgrade
// path.

import type { Book, CoverImage, Db, ReaderState, StoredInteractiveSource, StoredStream } from "./types";
import { appendToWordStream } from "../ingestion/interactive";

const DB_NAME = "speedreader";
const DB_VERSION = 2;

const STORE_BOOKS = "books";
const STORE_STREAMS = "streams";
const STORE_STATES = "readerStates";
const STORE_SOURCES = "interactiveSources";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
    req.onblocked = () => reject(new Error("IndexedDB open blocked"));
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
    if (!this.dbPromise) this.dbPromise = openDb();
    return this.dbPromise;
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
            const offsetWords = newWords.map((w, i) => ({ ...w, index: i }));
            const totalLen = offsetWords.reduce((sum, word) => sum + word.text.length, 0);
            updatedStream = {
              words: offsetWords,
              chapterIndex: options?.chapterUpdates ?? [],
              meta: {
                totalWords: offsetWords.length,
                avgWordLength: offsetWords.length ? totalLen / offsetWords.length : 0,
                isDeterministic: false,
                isComplete: options?.isComplete ?? false,
                totalWordsExpected: options?.totalWordsExpected,
                chapterAttribute: "chapterId",
              },
              ...(options?.interactions?.length ? { interactions: options.interactions } : {}),
              ...(options?.presentations?.length ? { presentations: options.presentations } : {}),
              ...(options?.triggers?.length ? { triggers: options.triggers } : {}),
            };
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

  async getReaderState(bookId: string): Promise<ReaderState | null> {
    const db = await this.db();
    const tx = db.transaction(STORE_STATES, "readonly");
    const store = tx.objectStore(STORE_STATES);
    return (await reqResult(store.get(bookId))) ?? null;
  }

  async saveReaderState(state: ReaderState): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_STATES, "readwrite");
    tx.objectStore(STORE_STATES).put(state);
    await txDone(tx);
  }

  async patchReaderState(
    bookId: string,
    patch: Partial<Omit<ReaderState, "bookId">>,
  ): Promise<ReaderState | null> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_STATES, "readwrite");
      const store = tx.objectStore(STORE_STATES);
      const request = store.get(bookId);
      let updated: ReaderState | null = null;
      request.onerror = () => reject(request.error ?? new Error("Failed to read reader state for patch"));
      request.onsuccess = () => {
        const existing = request.result as ReaderState | undefined;
        if (!existing) return;
        updated = { ...existing, ...patch, bookId };
        store.put(updated);
      };
      tx.oncomplete = () => resolve(updated);
      tx.onerror = () => reject(tx.error ?? new Error("Reader state patch transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Reader state patch transaction aborted"));
    });
  }

  async deleteReaderState(bookId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_STATES, "readwrite");
    tx.objectStore(STORE_STATES).delete(bookId);
    await txDone(tx);
  }

  async deleteBookCascade(bookId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([STORE_BOOKS, STORE_STREAMS, STORE_STATES, STORE_SOURCES], "readwrite");
    tx.objectStore(STORE_BOOKS).delete(bookId);
    tx.objectStore(STORE_STREAMS).delete(bookId);
    tx.objectStore(STORE_STATES).delete(bookId);
    tx.objectStore(STORE_SOURCES).delete(bookId);
    await txDone(tx);
  }
}

/** Re-export the CoverImage type for convenience. */
export type { CoverImage };
