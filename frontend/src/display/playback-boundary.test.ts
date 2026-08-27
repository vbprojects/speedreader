import { equal } from "node:assert/strict";
import { test } from "node:test";
import type { WordStream } from "../epub/types";
import { unresolvedInteractionAtBoundary } from "./playback-boundary";

const baseStream = (): WordStream => ({
  words: [{ text: "one", index: 0, metadata: [] }],
  chapterIndex: [],
  meta: { totalWords: 1, avgWordLength: 3, isDeterministic: true, chapterAttribute: "chapterId" },
});

test("inert presentations never block playback boundaries", () => {
  const stream = baseStream();
  stream.presentations = [
    { schemaVersion: 1, id: "start", boundary: 0, kind: "html", html: "<p>Start</p>" },
    { schemaVersion: 1, id: "end", boundary: 1, kind: "html", html: "<hr>" },
  ];
  equal(unresolvedInteractionAtBoundary(stream, 0, new Set(), new Set()), null);
  equal(unresolvedInteractionAtBoundary(stream, 1, new Set(), new Set()), null);

  stream.interactions = [{ schemaVersion: 1, id: "pause", boundary: 1, kind: "continue" }];
  equal(unresolvedInteractionAtBoundary(stream, 1, new Set(), new Set())?.id, "pause");
  equal(unresolvedInteractionAtBoundary(stream, 1, new Set(["pause"]), new Set()), null);
});
