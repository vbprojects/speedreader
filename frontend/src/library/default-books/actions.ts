// The bundled Actions book is a small, deterministic smoke test for the
// format-agnostic interaction reader. It deliberately uses the same persisted
// WordStream path as imported books so it remains available offline.

import type { Book } from "../../db/types";
import type { Word, WordStream } from "../../epub/types";
import { computeMeta } from "../../ingestion/normalize";
import type { ReaderInteraction } from "../../interactions/types";
import type { HtmlPresentation } from "../../presentation/types";
import { validatePresentations } from "../../presentation/validation";

export const ACTIONS_BOOK_ID = "builtin:actions:v1";
export const ACTIONS_BOOK_REVISION = 7;

const CHAPTER_ID = "actions";

function wordsFromText(text: string): Word[] {
  const words: Word[] = [];
  let pendingLineBreaks = 0;
  for (const [lineIndex, line] of text.split("\n").entries()) {
    if (lineIndex > 0) pendingLineBreaks++;
    const tokens = line.split(/\s+/).filter(Boolean);
    for (const [tokenIndex, token] of tokens.entries()) {
      words.push({
        text: token,
        index: words.length,
        metadata: [{ attribute: "chapterId", value: CHAPTER_ID }],
        ...(tokenIndex === 0 && pendingLineBreaks > 0
          ? { formatting: { lineBreaksBefore: pendingLineBreaks } }
          : {}),
      });
      if (tokenIndex === 0) pendingLineBreaks = 0;
    }
  }
  return words;
}

const storyWords = wordsFromText(
  "Welcome to Actions.\n" +
    "This short story demonstrates the reader's built-in interactive controls.\n" +
    "Your answer will be recorded while the story\n" +
    "continues in a single offline stream.\n\n\n\n" +
    "You have reached a fork in the path.\n" +
    "The choice is remembered, and the same reader can continue at its own pace.\n" +
    "The demonstration is complete.\n" +
    "You can restart Actions from the library whenever you want to try it again."
);

const interactions: ReaderInteraction[] = [
  {
    schemaVersion: 1,
    id: "actions:begin",
    boundary: 0,
    kind: "continue",
    editPolicy: "immutable",
    history: { kind: "statement", text: "You began the Actions story." },
    label: "Begin",
    prompt: "A tiny interactive story is ready.",
    description: "This first prompt demonstrates the default pause-and-continue behavior.",
  },
  {
    schemaVersion: 1,
    id: "actions:name",
    boundary: 16,
    kind: "text-input",
    editPolicy: "mutable",
    history: { kind: "value", prefix: "You introduced yourself as", suffix: ".", quoteValue: true },
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
    editPolicy: "immutable",
    prompt: "Which path should the explorer take?",
    options: [
      { id: "garden", label: "The glass garden", description: "A quiet route beneath bright leaves.", resolvedText: "You chose the glass garden." },
      { id: "tower", label: "The clock tower", description: "A taller route with a view of the whole story.", resolvedText: "You chose the clock tower." },
    ],
  },
  {
    schemaVersion: 1,
    id: "actions:finish",
    boundary: storyWords.length,
    kind: "continue",
    editPolicy: "immutable",
    history: { kind: "statement", text: "You finished the Actions demo." },
    label: "Finish",
    prompt: "You reached the end of the Actions demo.",
    description: "Restart the demo from the library to see every interaction again.",
  },
];

const presentations: HtmlPresentation[] = [
  {
    schemaVersion: 1,
    id: "actions:chapter-card",
    boundary: 12,
    kind: "html",
    html: "<hr><h3>A quiet interlude</h3><p><strong>Presentation HTML</strong> appears without pausing playback.</p>",
    renderIn: ["rsvp", "traditional"],
  },
  {
    schemaVersion: 1,
    id: "actions:traditional-note",
    boundary: 34,
    kind: "html",
    html: "<blockquote><em>This note is shown only in traditional reading mode.</em></blockquote>",
    renderIn: ["traditional"],
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
  const words = storyWords.map((word) => ({
    ...word,
    metadata: [...word.metadata],
    ...(word.formatting ? { formatting: { ...word.formatting } } : {}),
  }));
  return {
    words,
    chapterIndex: chapterIndex.map((chapter) => ({ ...chapter })),
    meta: computeMeta(words),
    // The descriptors are intentionally JSON-only; round-tripping here also
    // guarantees that each reader session receives an independent fixture.
    interactions: JSON.parse(JSON.stringify(interactions)) as ReaderInteraction[],
    presentations: validatePresentations(
      JSON.parse(JSON.stringify(presentations)) as HtmlPresentation[],
      words.length,
    ),
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
