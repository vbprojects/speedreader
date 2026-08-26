// src/library/index.ts
// Public surface of the library module.

export { LibraryStore, PARSER_VERSION } from "./store";
export { sha256 } from "./hash";
export type { Book, ImportResult, OpenableBook } from "./types";
export { ACTIONS_BOOK_ID, ACTIONS_BOOK_REVISION, createActionsBook, createActionsFixture, createActionsStream } from "./default-books/actions";
export { BLUESKY_JETSTREAM_BOOK_ID, BLUESKY_JETSTREAM_BOOK_REVISION, createBlueskyJetstreamBook, createBlueskyJetstreamFixture, createBlueskyJetstreamStream } from "./default-books/bluesky-jetstream";
