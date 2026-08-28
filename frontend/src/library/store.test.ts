import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import type { Book, Db, ReaderState, StoredInteractiveSource } from "../db/types";
import type { Word, WordStream } from "../epub/types";
import { IngestionEngine } from "../ingestion";
import {
  createActionsBook,
  createActionsFixture,
  ACTIONS_BOOK_ID,
  ACTIONS_BOOK_REVISION,
} from "./default-books/actions";
import { LibraryStore } from "./store";
import { BLUESKY_JETSTREAM_BOOK_ID } from "./default-books/bluesky-jetstream";
import { LLM_CHAT_BOOK_ID } from "./default-books/llm-chat";
import { JSDOM } from "jsdom";

class MemoryDb implements Db {
  books = new Map<string, Book>();
  streams = new Map<string, WordStream>();
  states = new Map<string, ReaderState>();
  sources = new Map<string, StoredInteractiveSource>();

  async getBook(id: string) { return this.books.get(id) ?? null; }
  async getBooks() { return [...this.books.values()]; }
  async addBook(book: Book) { this.books.set(book.id, book); }
  async updateBook(id: string, patch: Partial<Book>) {
    const book = this.books.get(id);
    if (book) this.books.set(id, { ...book, ...patch, id });
  }
  async deleteBook(id: string) { this.books.delete(id); }
  async getInteractiveSource(bookId: string) { return this.sources.get(bookId) ?? null; }
  async saveInteractiveSource(source: StoredInteractiveSource) { this.sources.set(source.bookId, source); }
  async deleteInteractiveSource(bookId: string) { this.sources.delete(bookId); }
  async getStream(bookId: string) { return this.streams.get(bookId) ?? null; }
  async saveStream(bookId: string, stream: WordStream) { this.streams.set(bookId, stream); }
  async appendStreamWords(_bookId: string, _words: Word[], _options?: Parameters<Db["appendStreamWords"]>[2]): Promise<WordStream> {
    throw new Error("not used by these tests");
  }
  async getReaderState(bookId: string) { return this.states.get(bookId) ?? null; }
  async saveReaderState(state: ReaderState) { this.states.set(state.bookId, state); }
  async patchReaderState(bookId: string, patch: Partial<Omit<ReaderState, "bookId">>) {
    const existing = this.states.get(bookId);
    if (!existing) return null;
    const updated = { ...existing, ...patch, bookId };
    this.states.set(bookId, updated);
    return updated;
  }
  async deleteReaderState(bookId: string) { this.states.delete(bookId); }
  async deleteBookCascade(bookId: string) {
    this.books.delete(bookId);
    this.streams.delete(bookId);
    this.states.delete(bookId);
    this.sources.delete(bookId);
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
  equal((await library.getBooks()).length, 3);
  equal((await library.openBook(ACTIONS_BOOK_ID))?.book.title, "Actions");
  equal((await library.openBook(BLUESKY_JETSTREAM_BOOK_ID))?.stream.meta.isComplete, false);
  equal((await library.openBook(LLM_CHAT_BOOK_ID))?.stream.interactions?.[0].id, "llm:input:0");

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
  equal((await db.getBook(ACTIONS_BOOK_ID))?.builtInRevision, ACTIONS_BOOK_REVISION);
  deepStrictEqual(await db.getReaderState(ACTIONS_BOOK_ID), state);
});

test("position saves preserve newer format-owned runtime state", async () => {
  const db = new MemoryDb();
  const library = store(db);
  await db.saveReaderState({
    bookId: "story",
    position: 4,
    lastOpenedAt: 1,
    settings: {},
    formatState: { schemaVersion: 1, save: "opaque-sugarcube-save" },
  });
  await library.saveReaderState({ bookId: "story", position: 9, lastOpenedAt: 2, settings: { wpm: 500 } });
  deepStrictEqual(await db.getReaderState("story"), {
    bookId: "story",
    position: 9,
    lastOpenedAt: 2,
    settings: { wpm: 500 },
    formatState: { schemaVersion: 1, save: "opaque-sugarcube-save" },
  });
});

test("opening Actions rehydrates formatting even when its cached stream is stale", async () => {
  const db = new MemoryDb();
  const library = store(db);
  await library.ensureBuiltInBooks();
  const cached = createActionsFixture().stream;
  cached.words = cached.words.map(({ formatting: _formatting, ...word }) => word);
  db.streams.set(ACTIONS_BOOK_ID, cached);

  const opened = await library.openBook(ACTIONS_BOOK_ID);
  equal(opened?.stream.words.filter((word) => word.formatting?.lineBreaksBefore).length, 7);
  equal(db.streams.get(ACTIONS_BOOK_ID)?.words.filter((word) => word.formatting).length, 7);
});

test("restart refreshes the Actions stream, clears progress, and preserves the built-in", async () => {
  const db = new MemoryDb();
  const library = store(db);
  await library.ensureBuiltInBooks();
  const staleStream = createActionsFixture().stream;
  staleStream.words = staleStream.words.map(({ formatting: _formatting, ...word }) => word);
  db.streams.set(ACTIONS_BOOK_ID, staleStream);
  await db.saveReaderState({ bookId: ACTIONS_BOOK_ID, position: 9, lastOpenedAt: 1, settings: {}, completedInteractionIds: ["actions:name"] });
  await library.resetReaderState(ACTIONS_BOOK_ID);
  equal(await db.getReaderState(ACTIONS_BOOK_ID), null);
  equal(
    (await db.getStream(ACTIONS_BOOK_ID))?.words.filter((word) => word.formatting?.lineBreaksBefore).length,
    7
  );
  equal((await db.getBook(ACTIONS_BOOK_ID))?.builtInRevision, ACTIONS_BOOK_REVISION);
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
  db.sources.set(imported.id, {
    bookId: imported.id,
    format: "sugarcube-2-runtime",
    schemaVersion: 1,
    mimeType: "text/html",
    html: "<!doctype html>",
    sourceHash: "a".repeat(64),
    story: { title: "Imported", ifid: "TEST", startNode: "1" },
  });
  await library.removeBook(imported.id);
  equal(await db.getBook(imported.id), null);
  equal(await db.getInteractiveSource(imported.id), null);
});

test("published SugarCube imports persist executable source separately and dedupe by bytes", async () => {
  const db = new MemoryDb();
  const library = store(db);
  const html = `<!doctype html><html><head><script id="script-sugarcube"></script></head><body>
    <tw-storydata name="Branching Story" ifid="IFID-1" startnode="1" format="SugarCube" format-version="2.37.3"></tw-storydata>
  </body></html>`;
  const encoded = new TextEncoder().encode(html);
  const file = { name: "branching.html", extension: "html", mimeType: "text/html", data: encoded.buffer };
  const parseHtml = (source: string) => new JSDOM(source).window.document;

  const imported = await library.importSugarCubeSource(file, parseHtml);
  equal(imported.existed, false);
  equal(imported.book.format, "sugarcube-2-runtime");
  equal(imported.book.title, "Branching Story");
  equal(imported.stream.meta.isComplete, false);
  equal(imported.book.ingestionWarnings?.[0].includes("executable applications"), true);
  const source = await library.getSugarCubeSource(imported.book.id);
  equal(source?.html, html);
  equal(source?.sourceHash, imported.book.id);
  equal(source?.story.formatVersion, "2.37.3");

  const duplicate = await library.importSugarCubeSource(file, parseHtml);
  equal(duplicate.existed, true);
  equal((await library.getBooks()).filter((book) => book.id === imported.book.id).length, 1);
});

test("clearing LLM Chat removes conversation state and restores its initial prompt", async () => {
  const db = new MemoryDb();
  const library = store(db);
  await library.ensureBuiltInBooks();
  const stream = (await db.getStream(LLM_CHAT_BOOK_ID))!;
  stream.words.push({ text: "Generated", index: stream.words.length, metadata: [] });
  await db.saveStream(LLM_CHAT_BOOK_ID, stream);
  await db.updateBook(LLM_CHAT_BOOK_ID, { formatState: { schemaVersion: 1, sessionId: "session", turn: 1 } });
  await db.saveReaderState({ bookId: LLM_CHAT_BOOK_ID, position: 2, lastOpenedAt: 1, settings: {} });

  await library.resetReaderState(LLM_CHAT_BOOK_ID);
  equal(await db.getReaderState(LLM_CHAT_BOOK_ID), null);
  equal((await db.getStream(LLM_CHAT_BOOK_ID))?.interactions?.[0].id, "llm:input:0");
  equal((await db.getBook(LLM_CHAT_BOOK_ID))?.formatState?.turn, 0);
});
