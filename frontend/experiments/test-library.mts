// test-library.mts
// Headless verification of the LibraryStore + SHA-256 hashing with a mock Db.
// IndexedDB itself needs a browser, so this exercises the store logic against
// an in-memory fake adapter.
//
// Usage (from frontend/):
//   npx tsx experiments/test-library.mts

import { LibraryStore, PARSER_VERSION } from "../src/library/index.ts";
import { sha256 } from "../src/library/hash.ts";
import type { Db, Book, ReaderState } from "../src/db/types.ts";
import type { WordStream } from "../src/epub/types.ts";
import type { FileInfo, IngestionEngine } from "../src/ingestion/index.ts";

/** Minimal in-memory Db for testing store logic. */
class MemoryDb implements Db {
  books = new Map<string, Book>();
  streams = new Map<string, WordStream>();
  states = new Map<string, ReaderState>();

  async getBook(id: string) { return this.books.get(id) ?? null; }
  async getBooks() { return [...this.books.values()]; }
  async addBook(book: Book) { this.books.set(book.id, book); }
  async updateBook(id: string, patch: Partial<Book>) {
    const b = this.books.get(id);
    if (b) this.books.set(id, { ...b, ...patch, id });
  }
  async deleteBook(id: string) { this.books.delete(id); }
  async getStream(bookId: string) { return this.streams.get(bookId) ?? null; }
  async saveStream(bookId: string, stream: WordStream) { this.streams.set(bookId, stream); }
  async getReaderState(bookId: string) { return this.states.get(bookId) ?? null; }
  async saveReaderState(state: ReaderState) { this.states.set(state.bookId, state); }
  async deleteReaderState(bookId: string) { this.states.delete(bookId); }
  async deleteBookCascade(bookId: string) {
    this.books.delete(bookId);
    this.streams.delete(bookId);
    this.states.delete(bookId);
  }
}

/** A fake parser that produces a deterministic stream + metadata. */
class FakeParser {
  readonly format = "epub";
  canParse(file: FileInfo) { return file.extension === "epub"; }
  async parse(file: FileInfo): Promise<WordStream> {
    const words = file.name.split(/\s+/).map((text, i) => ({
      text,
      index: i,
      metadata: [{ attribute: "chapterId", value: 0 }],
    }));
    return {
      words,
      chapterIndex: [{ chapterId: 0, title: file.name, startIndex: 0, endIndex: words.length - 1 }],
      meta: { totalWords: words.length, avgWordLength: 4, isDeterministic: true, chapterAttribute: "chapterId" },
    };
  }
  async getBookInfo(file: FileInfo) {
    return { title: "Fake Title", author: "Fake Author" };
  }
}

class FakeEngine implements IngestionEngine {
  formats = ["epub"];
  parserFor(file: FileInfo) { return new FakeParser(); }
  async ingest(file: FileInfo) { return new FakeParser().parse(file); }
  register() {}
}

function makeFile(name: string): FileInfo {
  const bytes = new TextEncoder().encode(name);
  return {
    name,
    extension: "epub",
    data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

async function main() {
  const db = new MemoryDb();
  const store = new LibraryStore(db, new FakeEngine());

  // 1. SHA-256 is deterministic.
  const a = await sha256(makeFile("book.epub").data);
  const b = await sha256(makeFile("book.epub").data);
  const c = await sha256(makeFile("other.epub").data);
  console.log("SHA-256 deterministic:", a === b ? "PASS" : "FAIL");
  console.log("SHA-256 distinct inputs differ:", a !== c ? "PASS" : "FAIL");

  // 2. Import adds a book with metadata + stream.
  const r1 = await store.importFile(makeFile("book.epub"));
  console.log("\nImport new book:", r1.existed === false ? "PASS" : "FAIL");
  console.log("  title from metadata:", r1.book.title === "Fake Title" ? "PASS" : `FAIL (${r1.book.title})`);
  console.log("  author from metadata:", r1.book.author === "Fake Author" ? "PASS" : `FAIL (${r1.book.author})`);
  console.log("  parserVersion:", r1.book.parserVersion === PARSER_VERSION ? "PASS" : "FAIL");
  console.log("  wordCount:", r1.book.wordCount === 1 ? "PASS" : `FAIL (${r1.book.wordCount})`);

  // 3. Re-importing identical bytes dedupes.
  const r2 = await store.importFile(makeFile("book.epub"));
  console.log("\nDedupe identical import:", r2.existed === true ? "PASS" : "FAIL");
  console.log("  same id:", r2.book.id === r1.book.id ? "PASS" : "FAIL");
  console.log("  only one book:", (await db.getBooks()).length === 1 ? "PASS" : "FAIL");

  // 4. Open returns the cached stream (no re-parse).
  const opened = await store.openBook(r1.book.id);
  console.log("\nOpen cached stream:", opened?.stream.meta.totalWords === 1 ? "PASS" : "FAIL");

  // 5. Reader state round-trip.
  await store.saveReaderState({ bookId: r1.book.id, position: 1, lastOpenedAt: Date.now(), settings: { wpm: 800 } });
  const st = await store.getReaderState(r1.book.id);
  console.log("\nReader state round-trip:", st?.position === 1 && st.settings.wpm === 800 ? "PASS" : "FAIL");

  // 6. Cascade remove deletes book + stream + state.
  await store.removeBook(r1.book.id);
  const booksAfter = await db.getBooks();
  const streamAfter = await db.getStream(r1.book.id);
  const stateAfter = await db.getReaderState(r1.book.id);
  console.log("\nCascade remove:", booksAfter.length === 0 && streamAfter === null && stateAfter === null ? "PASS" : "FAIL");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});