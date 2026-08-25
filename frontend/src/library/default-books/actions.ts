// The bundled Actions book is a small, deterministic smoke test for the
// format-agnostic interaction reader. It deliberately uses the same persisted
// WordStream path as imported books so it remains available offline.

import type { Book } from "../../db/types";
import type { Word, WordStream } from "../../epub/types";
import { computeMeta } from "../../ingestion/normalize";
import type { ReaderInteraction } from "../../interactions/types";

export const ACTIONS_BOOK_ID = "builtin:actions:v1";
export const ACTIONS_BOOK_REVISION = 1;

const CHAPTER_ID = "actions";

function wordsFromText(text: string): Word[] {
  return text.split(/\s+/).filter(Boolean).map((token, index) => ({
    text: token,
    index,
    metadata: [{ attribute: "chapterId", value: CHAPTER_ID }],
  }));
}

const storyWords = wordsFromText(
  "Welcome to Actions. This short story demonstrates the reader's built-in interactive controls. " +
    "Your answer will be recorded while the story continues in a single offline stream. " +
    "You have reached a fork in the path. The choice is remembered, and the same reader can continue at its own pace. " +
    "The demonstration is complete. You can restart Actions from the library whenever you want to try it again."
);

const interactions: ReaderInteraction[] = [
  {
    schemaVersion: 1,
    id: "actions:begin",
    boundary: 0,
    kind: "continue",
    label: "Begin",
    prompt: "A tiny interactive story is ready.",
    description: "This first prompt demonstrates the default pause-and-continue behavior.",
  },
  {
    schemaVersion: 1,
    id: "actions:name",
    boundary: 16,
    kind: "text-input",
    label: "What should the story call you?",
    placeholder: "Your name",
    prompt: "Enter a name to continue.",
    constraints: { required: true, maxLength: 40 },
    submitLabel: "Save name",
  },
  {
    schemaVersion: 1,
    id: "actions:path",
    boundary: 34,
    kind: "single-choice",
    prompt: "Which path should the explorer take?",
    options: [
      { id: "garden", label: "The glass garden", description: "A quiet route beneath bright leaves." },
      { id: "tower", label: "The clock tower", description: "A taller route with a view of the whole story." },
    ],
  },
  {
    schemaVersion: 1,
    id: "actions:finish",
    boundary: storyWords.length,
    kind: "continue",
    label: "Finish",
    prompt: "You reached the end of the Actions demo.",
    description: "Restart the demo from the library to see every interaction again.",
  },
];

const chapterIndex = [{
  chapterId: CHAPTER_ID,
  title: "Actions",
  startIndex: 0,
  endIndex: Math.max(0, storyWords.length - 1),
}];

/** Return a fresh stream so callers cannot mutate the module-level fixture. */
export function createActionsStream(): WordStream {
  const words = storyWords.map((word) => ({ ...word, metadata: [...word.metadata] }));
  return {
    words,
    chapterIndex: chapterIndex.map((chapter) => ({ ...chapter })),
    meta: computeMeta(words),
    // The descriptors are intentionally JSON-only; round-tripping here also
    // guarantees that each reader session receives an independent fixture.
    interactions: JSON.parse(JSON.stringify(interactions)) as ReaderInteraction[],
  };
}

export function createActionsBook(addedAt = Date.now()): Book {
  const stream = createActionsStream();
  return {
    id: ACTIONS_BOOK_ID,
    title: "Actions",
    author: "Speedreader",
    format: "interactive-demo",
    addedAt,
    wordCount: stream.meta.totalWords,
    chapterCount: stream.chapterIndex.length,
    parserVersion: 1,
    builtIn: true,
    builtInRevision: ACTIONS_BOOK_REVISION,
  };
}

export function createActionsFixture(addedAt = Date.now()): { book: Book; stream: WordStream } {
  return { book: createActionsBook(addedAt), stream: createActionsStream() };
}
