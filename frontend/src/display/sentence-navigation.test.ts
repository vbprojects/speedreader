import { deepStrictEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { textToStream } from "../ingestion/text";
import { sentenceDestination, sentenceStarts } from "./sentence-navigation";
import { firstUnresolvedInteractionCrossed } from "./playback-boundary";

test("sentence navigation returns to the current sentence start, then the previous one", () => {
  const words = textToStream('Dr. Smith arrived. “Hello there!”\n\nA new paragraph without punctuation\n\nLast paragraph').words;
  const starts = sentenceStarts(words);
  deepStrictEqual(starts, [0, 3, 5, 10]);
  equal(sentenceDestination(starts, 4, -1, words.length), 3);
  equal(sentenceDestination(starts, 3, -1, words.length), 0);
  equal(sentenceDestination(starts, 3, 1, words.length), 5);
  equal(sentenceDestination(starts, 4, 1, words.length), 5);
  equal(sentenceDestination(starts, 11, 1, words.length), 11);
  equal(sentenceDestination([], 0, -1, 0), 0);
});

test("sentence destinations remain gated by an unresolved action", () => {
  const stream = textToStream("First sentence. Second sentence. Third sentence.");
  stream.interactions = [{ schemaVersion: 1, id: "choice", kind: "continue", boundary: 2, label: "Continue" }];
  const destination = sentenceDestination(sentenceStarts(stream.words), 0, 1, stream.words.length);
  equal(destination, 2);
  equal(firstUnresolvedInteractionCrossed(stream, 0, destination, new Set(), new Map())?.id, "choice");
});
