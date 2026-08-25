import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { test } from "node:test";
import type { WordStream } from "../epub/types";
import { appendToWordStream } from "./interactive";

const word = (text: string, index: number) => ({ text, index, metadata: [] });

function emptyStream(): WordStream {
  return {
    words: [],
    chapterIndex: [],
    meta: { totalWords: 0, avgWordLength: 0, isDeterministic: false, isComplete: false, chapterAttribute: "chapterId" },
  };
}

test("chunk-relative interaction boundaries become global boundaries", () => {
  const first = appendToWordStream(emptyStream(), [word("Hello", 99), word("there", 99)], {
    interactions: [{ schemaVersion: 1, id: "name", boundary: 0, kind: "text-input", label: "Name" }],
  });
  const second = appendToWordStream(first, [word("friend", 99)], {
    interactions: [{ schemaVersion: 1, id: "choice", boundary: 1, kind: "single-choice", options: [{ id: "a", label: "A" }] }],
    isComplete: true,
  });
  equal(second.words[2].index, 2);
  deepStrictEqual(second.interactions?.map((item) => [item.id, item.boundary]), [["name", 0], ["choice", 3]]);
  equal(second.meta.isComplete, true);
});

test("interaction-only chunks and duplicate IDs are handled safely", () => {
  const stream = appendToWordStream(emptyStream(), [word("one", 0)]);
  const withPrompt = appendToWordStream(stream, [], {
    interactions: [{ schemaVersion: 1, id: "pause", boundary: 0, kind: "continue" }],
  });
  equal(withPrompt.interactions?.[0].boundary, 1);
  throws(() => appendToWordStream(withPrompt, [], {
    interactions: [{ schemaVersion: 1, id: "pause", boundary: 0, kind: "continue" }],
  }));
});
