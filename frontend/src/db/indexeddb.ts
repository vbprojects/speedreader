// src/db/indexeddb.ts
// IndexedDB adapter for the `db` interface. Offline-first, origin-local.
// Stores books, full word streams, and per-book reader state as structured
// clones. Versioned schema with an upgrade path.

import type { Book, CoverImage, Db, ReaderState, StoredStream } from "./types";

const DB_NAME = "speedreader";
const DB_VERSION = 1;

const STORE_BOOKS = "books";
const STORE_STREAMS = "streams";
const STORE_STATES = "readerStates";

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
    const tx = db.transaction(STORE_BOOKS, "readwrite");
    const store = tx.objectStore(STORE_BOOKS);
    const existing = await reqResult(store.get(id));
    if (existing) store.put({ ...existing, ...patch, id });
    await txDone(tx);
  }

  async deleteBook(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_BOOKS, "readwrite");
    tx.objectStore(STORE_BOOKS).delete(id);
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
      isComplete?: boolean;
      totalWordsExpected?: number;
    }
  ): Promise<import("../epub/types").WordStream> {
    const db = await this.db();
    const tx = db.transaction(STORE_STREAMS, "readwrite");
    const store = tx.objectStore(STORE_STREAMS);
    const rec = (await reqResult(store.get(bookId))) as StoredStream | undefined;

    let updatedStream: import("../epub/types").WordStream;
    if (rec?.stream) {
      const { appendToWordStream } = await import("../ingestion/interactive");
      updatedStream = appendToWordStream(rec.stream, newWords, options);
    } else {
      const offsetWords = newWords.map((w, i) => ({ ...w, index: i }));
      const totalLen = offsetWords.reduce((s, w) => s + w.text.length, 0);
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
          ...(options?.interactions && options.interactions.length > 0 ? { interactions: options.interactions } : {}),
        },
      };
    }

    store.put({ bookId, stream: updatedStream } satisfies StoredStream);
    await txDone(tx);
    return updatedStream;
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

  async deleteReaderState(bookId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_STATES, "readwrite");
    tx.objectStore(STORE_STATES).delete(bookId);
    await txDone(tx);
  }

  async deleteBookCascade(bookId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([STORE_BOOKS, STORE_STREAMS, STORE_STATES], "readwrite");
    tx.objectStore(STORE_BOOKS).delete(bookId);
    tx.objectStore(STORE_STREAMS).delete(bookId);
    tx.objectStore(STORE_STATES).delete(bookId);
    await txDone(tx);
  }
}

/** Re-export the CoverImage type for convenience. */
export type { CoverImage };