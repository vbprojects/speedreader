// src/library/types.ts
// Library book model and import result types.

import type { Book } from "../db/types";
import type { WordStream } from "../epub/types";

/** Re-export the persisted Book model. */
export type { Book } from "../db/types";

/** Result of importing a file into the library. */
export interface ImportResult {
  book: Book;
  stream: WordStream;
  /** True if the book already existed (dedupe) vs. newly added. */
  existed: boolean;
}

/** A book plus its cached stream, ready to open a reader. */
export interface OpenableBook {
  book: Book;
  stream: WordStream;
}