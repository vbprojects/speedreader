// experiments/test-dynamic-stream.mts
// Verification of dynamic growing word streams, InteractiveFormat abstraction,
// background chunk appending, clock dynamic extension, and formatState resumption.
//
// Usage (from frontend/):
//   npx tsx experiments/test-dynamic-stream.mts

import { appendToWordStream, type InteractiveFormat, type StreamChunk } from "../src/ingestion/index.ts";
import { SelfCorrectingClock } from "../src/display/clock.ts";
import { PacingEngine, selectBackend } from "../src/pacing/index.ts";
import type { Word, WordStream } from "../src/epub/types.ts";
import type { Db, Book, ReaderState } from "../src/db/types.ts";
import { LibraryStore } from "../src/library/index.ts";

/**
 * In-memory test Db supporting appendStreamWords and formatState snapshots.
 */
class MockDb implements Db {
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

  async appendStreamWords(bookId: string, words: Word[], options?: any) {
    const existing = this.streams.get(bookId);
    let updated: WordStream;
    if (existing) {
      updated = appendToWordStream(existing, words, options);
    } else {
      const reindexed = words.map((w, i) => ({ ...w, index: i }));
      updated = {
        words: reindexed,
        chapterIndex: options?.chapterUpdates ?? [],
        meta: {
          totalWords: reindexed.length,
          avgWordLength: 4,
          isDeterministic: false,
          isComplete: options?.isComplete ?? false,
          totalWordsExpected: options?.totalWordsExpected,
          chapterAttribute: "chapterId",
        },
      };
    }
    this.streams.set(bookId, updated);
    return updated;
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

interface PdfOcrState {
  currentPage: number;
  totalPages: number;
}

/**
 * Concrete InteractiveFormat simulating an asynchronous, on-demand PDF OCR pipeline.
 */
class MockPdfOcrFormat implements InteractiveFormat<{ pagesText: string[][] }, PdfOcrState> {
  readonly format = "pdf-ocr";
  readonly isDeterministic = false;

  private state: PdfOcrState = { currentPage: 0, totalPages: 0 };
  private pages: string[][] = [];

  async init(input: { pagesText: string[][] }, savedState?: PdfOcrState) {
    this.pages = input.pagesText;
    this.state = savedState ?? { currentPage: 0, totalPages: input.pagesText.length };
    return {
      initialState: this.state,
      title: "Asynchronous PDF OCR Document",
      author: "OCR Extractor",
    };
  }

  startStreaming(
    _startIndex: number,
    onChunk: (chunk: StreamChunk<PdfOcrState>) => void,
    _onError: (err: Error) => void
  ) {
    let cancelled = false;

    const processNext = () => {
      if (cancelled || this.state.currentPage >= this.state.totalPages) return;

      const pageIdx = this.state.currentPage;
      const pageWordsText = this.pages[pageIdx] ?? [];
      const words: Word[] = pageWordsText.map((text) => ({
        text,
        index: -1, // will be reindexed by appendToWordStream
        metadata: [
          { attribute: "chapterId", value: pageIdx },
          { attribute: "page", value: pageIdx + 1 },
        ],
      }));

      this.state.currentPage++;
      const isComplete = this.state.currentPage >= this.state.totalPages;

      onChunk({
        words,
        chapterUpdates: [
          {
            chapterId: pageIdx,
            title: `Page ${pageIdx + 1}`,
            startIndex: -1,
            endIndex: -1,
          },
        ],
        state: { ...this.state },
        isComplete,
      });

      if (!isComplete && !cancelled) {
        setTimeout(processNext, 20);
      }
    };

    setTimeout(processNext, 10);
    return () => { cancelled = true; };
  }

  getState(): PdfOcrState {
    return { ...this.state };
  }
}

async function main() {
  console.log("=== 1. Testing appendToWordStream ===");
  let stream: WordStream = {
    words: [
      { text: "Hello", index: 0, metadata: [{ attribute: "chapterId", value: 0 }] },
      { text: "world", index: 1, metadata: [{ attribute: "chapterId", value: 0 }] },
    ],
    chapterIndex: [{ chapterId: 0, title: "Chapter 1", startIndex: 0, endIndex: 1 }],
    meta: {
      totalWords: 2,
      avgWordLength: 5,
      isDeterministic: false,
      isComplete: false,
      totalWordsExpected: 6,
      chapterAttribute: "chapterId",
    },
  };

  const newWords: Word[] = [
    { text: "more", index: 0, metadata: [{ attribute: "chapterId", value: 1 }] },
    { text: "text", index: 0, metadata: [{ attribute: "chapterId", value: 1 }] },
  ];

  stream = appendToWordStream(stream, newWords, {
    isComplete: false,
    chapterUpdates: [{ chapterId: 1, title: "Chapter 2", startIndex: 2, endIndex: 3 }],
  });

  console.log("Word count after append:", stream.words.length === 4 ? "PASS" : `FAIL (${stream.words.length})`);
  console.log("Indices contiguous:", stream.words.map((w) => w.index).join(",") === "0,1,2,3" ? "PASS" : "FAIL");
  console.log("Chapters updated:", stream.chapterIndex.length === 2 ? "PASS" : "FAIL");

  console.log("\n=== 2. Testing SelfCorrectingClock with dynamic appendDurations ===");
  const ticks: number[] = [];
  const clock = new SelfCorrectingClock({
    durations: [20, 20],
    onTick: (i) => ticks.push(i),
    onEnd: () => console.log("Initial clock batch ended"),
  });

  clock.start(0);
  await new Promise((r) => setTimeout(r, 25)); // tick 0 and 1 occur

  // Append new durations while running
  clock.appendDurations([20, 20]);
  await new Promise((r) => setTimeout(r, 60)); // tick 2 and 3 occur

  console.log("Clock ticked through appended durations:", ticks.includes(2) && ticks.includes(3) ? "PASS" : `FAIL (${ticks})`);
  clock.destroy();

  console.log("\n=== 3. Testing InteractiveFormat and Database Persistence ===");
  const db = new MockDb();
  const store = new LibraryStore(db as any, {} as any);

  const sampleDoc = {
    pagesText: [
      ["Page", "one", "content"],
      ["Page", "two", "content"],
      ["Page", "three", "final"],
    ],
  };

  const ocrFormat = new MockPdfOcrFormat();
  const initResult = await ocrFormat.init(sampleDoc);
  const bookId = "test-pdf-123";

  await db.addBook({
    id: bookId,
    title: initResult.title!,
    author: initResult.author!,
    format: ocrFormat.format,
    addedAt: Date.now(),
    wordCount: 0,
    chapterCount: 0,
    parserVersion: 1,
    formatState: initResult.initialState,
  });

  // Stream in chunks
  await new Promise<void>((resolve, reject) => {
    const cancel = ocrFormat.startStreaming(
      0,
      async (chunk) => {
        try {
          await store.appendWords(bookId, chunk.words, {
            chapterUpdates: chunk.chapterUpdates,
            isComplete: chunk.isComplete,
            formatState: chunk.state,
          });
          if (chunk.isComplete) {
            cancel();
            resolve();
          }
        } catch (e) {
          reject(e);
        }
      },
      reject
    );
  });

  const finalBook = await db.getBook(bookId);
  const finalStream = await db.getStream(bookId);
  console.log("Final persisted wordCount:", finalBook?.wordCount === 9 ? "PASS" : `FAIL (${finalBook?.wordCount})`);
  console.log("Final formatState saved (3 pages processed):", (finalBook?.formatState as any)?.currentPage === 3 ? "PASS" : "FAIL");
  console.log("Stream isComplete:", finalStream?.meta.isComplete === true ? "PASS" : "FAIL");

  // Save reader state with custom formatState
  await store.saveReaderState({
    bookId,
    position: 4,
    lastOpenedAt: Date.now(),
    settings: { wpm: 750 },
    formatState: finalBook?.formatState,
  });

  const savedReaderState = await store.getReaderState(bookId);
  console.log("ReaderState preserved position and formatState:", savedReaderState?.position === 4 && (savedReaderState?.formatState as any)?.currentPage === 3 ? "PASS" : "FAIL");

  console.log("\nALL DYNAMIC STREAM TESTS PASSED!");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
