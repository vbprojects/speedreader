import { equal, match } from "node:assert/strict";
import { test } from "node:test";
import { availability, lastReadBook, readingMinutes, importRecovery } from "./reading-info";
import { createActionsBook } from "./default-books/actions";

test("continue reading uses last-opened time rather than import order and includes position zero", () => {
  const first = { ...createActionsBook(100), id: "first" };
  const second = { ...createActionsBook(200), id: "second" };
  equal(lastReadBook([first, second], {
    first: { bookId: first.id, position: 0, lastOpenedAt: 500, settings: {} },
    second: { bookId: second.id, position: 4, lastOpenedAt: 400, settings: {} },
  })?.id, first.id);
  equal(lastReadBook([first, second], {}), undefined);
});

test("availability distinguishes saved content, network sources, and an unavailable story engine", () => {
  const book = createActionsBook(1);
  equal(availability(book), "Available offline");
  equal(availability({ ...book, format: "pdf" }), "Available offline");
  equal(availability({ ...book, format: "bluesky-jetstream" }), "Requires connection for new content");
  equal(availability({ ...book, format: "openai-compatible-llm" }), "Requires connection for new content");
  equal(availability({ ...book, format: "sugarcube-2-runtime" }), "Reader engine unavailable");
  equal(readingMinutes(1200, 600), 2);
  equal(readingMinutes(1200, 0), 4);
  match(importRecovery("Failed to fetch"), /download the file from its source page/);
  match(importRecovery("No readable text found"), /selectable text/);
});
