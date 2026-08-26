import type { Book } from "../../db/types";
import type { WordStream } from "../../epub/types";
import { JETSTREAM_FORMAT, type JetstreamState } from "../../ingestion/jetstream";

export const BLUESKY_JETSTREAM_BOOK_ID = "builtin:bluesky-jetstream:v1";
export const BLUESKY_JETSTREAM_BOOK_REVISION = 1;

export function createBlueskyJetstreamStream(): WordStream {
  return {
    words: [],
    chapterIndex: [],
    meta: {
      totalWords: 0,
      avgWordLength: 0,
      isDeterministic: false,
      isComplete: false,
      chapterAttribute: "chapterId",
    },
  };
}

export function createBlueskyJetstreamState(): JetstreamState {
  return { schemaVersion: 1, recentEventKeys: [], acceptedPostCount: 0 };
}

export function createBlueskyJetstreamBook(addedAt = Date.now()): Book {
  return {
    id: BLUESKY_JETSTREAM_BOOK_ID,
    title: "Bluesky Jetstream",
    author: "Bluesky",
    format: JETSTREAM_FORMAT,
    addedAt,
    wordCount: 0,
    chapterCount: 0,
    parserVersion: 1,
    builtIn: true,
    builtInRevision: BLUESKY_JETSTREAM_BOOK_REVISION,
    formatState: createBlueskyJetstreamState(),
  };
}

export function createBlueskyJetstreamFixture(addedAt = Date.now()): { book: Book; stream: WordStream } {
  return { book: createBlueskyJetstreamBook(addedAt), stream: createBlueskyJetstreamStream() };
}
