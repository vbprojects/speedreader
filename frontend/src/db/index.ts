// src/db/index.ts
// Public surface of the db module: a factory that picks an adapter.

import type { Db } from "./types";
import { IndexedDb } from "./indexeddb";

export type { Db, Book, CoverImage, ReaderState, StoredInteractiveSource, StoredStream } from "./types";

/**
 * Create a db adapter. For now only the browser IndexedDB adapter exists;
 * WASM/desktop/server adapters can be added here later without changing
 * callers.
 */
export function createDb(type: "indexeddb" = "indexeddb"): Db {
  switch (type) {
    case "indexeddb":
      return new IndexedDb();
    default:
      throw new Error(`Unknown db adapter: ${type}`);
  }
}
