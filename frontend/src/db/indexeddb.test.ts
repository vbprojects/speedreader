import { test } from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDb } from "./indexeddb";
import { textToStream } from "../ingestion/text";

test("version two upgrade preserves books and adds durable originals, selections and blocks", async () => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: indexedDB });
  const old = await new Promise<IDBDatabase>((resolve,reject) => {
    const request = indexedDB.open("speedreader", 2);
    request.onupgradeneeded = () => {
      for (const name of ["books","streams","readerStates","interactiveSources"])
        request.result.createObjectStore(name, { keyPath: name === "books" ? "id" : "bookId" });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const book = { id: "test", title: "Test", author: "Author", format: "epub", addedAt: 1, wordCount: 2, chapterCount: 1, parserVersion: 1 };
  await new Promise<void>((resolve,reject) => {
    const tx = old.transaction("books","readwrite"); tx.objectStore("books").put(book);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  old.close();
  const db = new IndexedDb();
  assert.deepEqual(await db.getBook("test"),book);
  const file = { bookId: "test", name: "test.epub", extension: "epub", data: new Uint8Array([1,2,3]).buffer };
  await db.saveSourceFile(file);
  await db.updateBook("test", { presenterSelection: { layout: "book-layout", behaviors: [] }, removedAt: 5 });
  const stream = textToStream("one two");
  stream.blocks = [{ id:"p", sourceRef:"p", kind:"paragraph", start:0, end:2 }];
  await db.saveStream("test",stream);
  const reopened = new IndexedDb();
  assert.deepEqual(await reopened.getSourceFile("test"),file);
  assert.equal((await reopened.getBook("test"))?.presenterSelection?.layout,"book-layout");
  await reopened.updateBook("test",{ removedAt: undefined });
  assert.deepEqual((await reopened.getStream("test"))?.blocks,stream.blocks);
  const appended = await reopened.appendStreamWords("test", textToStream("three four").words, {
    blocks: [{ id: "p2", sourceRef: "p2", kind: "paragraph", start: 0, end: 2 }],
  });
  assert.deepEqual(appended.blocks?.map(block => [block.id, block.start, block.end]), [["p", 0, 2], ["p2", 2, 4]]);
  await assert.rejects(reopened.appendStreamWords("test", [], {
    blocks: [{ id: "invalid", sourceRef: "invalid", kind: "paragraph", start: 0, end: 1 }],
  }));
  assert.equal((await reopened.getStream("test"))?.words.length, 4);
  await reopened.deleteBookCascade("test");
  assert.equal(await db.getSourceFile("test"),null);
  assert.equal(await db.getBook("test"),null);
  assert.equal(await db.getStream("test"),null);
});
