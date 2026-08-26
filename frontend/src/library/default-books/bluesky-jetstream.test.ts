import { equal } from "node:assert/strict";
import { test } from "node:test";
import { JETSTREAM_FORMAT } from "../../ingestion/jetstream";
import { BLUESKY_JETSTREAM_BOOK_ID, createBlueskyJetstreamFixture } from "./bluesky-jetstream";

test("Bluesky Jetstream is a stable empty, incomplete built-in stream", () => {
  const { book, stream } = createBlueskyJetstreamFixture(123);
  equal(book.id, BLUESKY_JETSTREAM_BOOK_ID);
  equal(book.format, JETSTREAM_FORMAT);
  equal(book.builtIn, true);
  equal(stream.words.length, 0);
  equal(stream.meta.isComplete, false);
  equal(stream.meta.isDeterministic, false);
});
