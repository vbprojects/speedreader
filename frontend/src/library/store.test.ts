import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import type { Book, Db, ReaderState } from "../db/types";
import type { Word, WordStream } from "../epub/types";
import { IngestionEngine } from "../ingestion";
import { createActionsBook, createActionsFixture, ACTIONS_BOOK_ID } from "./default-books/actions";
import { LibraryStore } from "./store";
import { BLUESKY_JETSTREAM_BOOK_ID } from "./default-books/bluesky-jetstream";

class MemoryDb implements Db {
  books = new Map<string, Book>();
  streams = new Map<string, WordStream>();
  states = new Map<string, ReaderState>();

  async getBook(id: string) { return this.books.get(id) ?? null; }
  async getBooks() { return [...this.books.values()]; }
  async addBook(book: Book) { this.books.set(book.id, book); }
  async updateBook(id: string, patch: Partial<Book>) {
    const book = this.books.get(id);
    if (book) this.books.set(id, { ...book, ...patch, id });
  }
  async deleteBook(id: string) { this.books.delete(id); }
  async getStream(bookId: string) { return this.streams.get(bookId) ?? null; }
  async saveStream(bookId: string, stream: WordStream) { this.streams.set(bookId, stream); }
  async appendStreamWords(_bookId: string, _words: Word[], _options?: Parameters<Db["appendStreamWords"]>[2]): Promise<WordStream> {
    throw new Error("not used by these tests");
  }
  async getReaderState(bookId: string) { return this.states.get(bookId) ?? null; }
  async saveReaderState(state: ReaderState) { this.states.set(state.bookId, state); }
  async deleteReaderState(bookId: string) { this.states.delete(bookId); }
  async deleteBookCascade(bookId: string) {
    this.books.delete(bookId);
    this.streams.delete(bookId);
    this.states.delete(bookId);
  }
}

function store(db: MemoryDb): LibraryStore {
  return new LibraryStore(db, new IngestionEngine([]));
}

test("ensureBuiltInBooks seeds Actions once and repairs a missing stream", async () => {
  const db = new MemoryDb();
  const library = store(db);
  await library.ensureBuiltInBooks();
  await library.ensureBuiltInBooks();
  equal((await library.getBooks()).length, 2);
  equal((await library.openBook(ACTIONS_BOOK_ID))?.book.title, "Actions");
  equal((await library.openBook(BLUESKY_JETSTREAM_BOOK_ID))?.stream.meta.isComplete, false);

  db.streams.delete(ACTIONS_BOOK_ID);
  await library.ensureBuiltInBooks();
  equal((await library.openBook(ACTIONS_BOOK_ID))?.stream.interactions?.length, 4);
});

test("a stale bundled revision is replaced without deleting reader state", async () => {
  const db = new MemoryDb();
  const library = store(db);
  const fixture = createActionsFixture(100);
  db.books.set(ACTIONS_BOOK_ID, { ...fixture.book, builtInRevision: 0 });
  db.streams.set(ACTIONS_BOOK_ID, fixture.stream);
  const state: ReaderState = { bookId: ACTIONS_BOOK_ID, position: 7, lastOpenedAt: 1, settings: {}, completedInteractionIds: ["actions:begin"] };
  await db.saveReaderState(state);

  await library.ensureBuiltInBooks();
  equal((await db.getBook(ACTIONS_BOOK_ID))?.builtInRevision, 1);
  deepStrictEqual(await db.getReaderState(ACTIONS_BOOK_ID), state);
});

test("restart clears only Actions reader progress and built-ins cannot be removed", async () => {
  const db = new MemoryDb();
  const library = store(db);
  await library.ensureBuiltInBooks();
  await db.saveReaderState({ bookId: ACTIONS_BOOK_ID, position: 9, lastOpenedAt: 1, settings: {}, completedInteractionIds: ["actions:name"] });
  await library.resetReaderState(ACTIONS_BOOK_ID);
  equal(await db.getReaderState(ACTIONS_BOOK_ID), null);
  await rejects(() => library.removeBook(ACTIONS_BOOK_ID), /Built-in books cannot be removed/);
});

test("regular imported books remain removable", async () => {
  const db = new MemoryDb();
  const library = store(db);
  const imported = createActionsBook(1);
  imported.id = "imported-book";
  imported.builtIn = false;
  imported.builtInRevision = undefined;
  db.books.set(imported.id, imported);
  await library.removeBook(imported.id);
  equal(await db.getBook(imported.id), null);
});
