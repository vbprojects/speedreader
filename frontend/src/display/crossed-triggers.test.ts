import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { WordStream } from "../epub/types";
import { crossedEngineTriggers } from "./crossed-triggers";

const stream: WordStream = {
  words: [0, 1, 2].map((index) => ({ text: String(index), index, metadata: [] })),
  chapterIndex: [],
  meta: { totalWords: 3, avgWordLength: 1, isDeterministic: false, chapterAttribute: "chapterId" },
  triggers: [0, 1, 2].map((boundary) => ({
    schemaVersion: 1,
    id: `t${boundary}`,
    boundary,
    kind: "engine-trigger",
    signal: { type: "test" },
  })),
};

test("forward playback dispatches crossed undelivered triggers without backward repeats", () => {
  deepStrictEqual(crossedEngineTriggers(stream, -1, 0, new Set()).map((item) => item.id), ["t0"]);
  deepStrictEqual(crossedEngineTriggers(stream, 0, 2, new Set(["t1"])).map((item) => item.id), ["t2"]);
  deepStrictEqual(crossedEngineTriggers(stream, 2, 0, new Set()).map((item) => item.id), []);
});
