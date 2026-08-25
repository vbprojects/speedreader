import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { buildReaderFlowRange } from "./flow";
import type { ReaderInteraction } from "./types";

const words = [0, 1, 2].map((index) => ({ text: `w${index}`, index, metadata: [] }));
const interaction = (id: string, boundary: number): ReaderInteraction => ({ schemaVersion: 1, id, boundary, kind: "continue" });

test("flow places boundary actions before the following word and retains the final action", () => {
    const nodes = buildReaderFlowRange(words, [interaction("start", 0), interaction("middle", 2), interaction("end", 3)]);
    deepStrictEqual(nodes.map((node) => node.kind === "word" ? node.word.text : node.interaction.id), ["start", "w0", "w1", "middle", "w2", "end"]);
});

test("flow preserves declaration order for actions at one boundary", () => {
    const nodes = buildReaderFlowRange(words, [interaction("a", 1), interaction("b", 1)]);
    deepStrictEqual(nodes.filter((node) => node.kind === "interaction").map((node) => node.interaction.id), ["a", "b"]);
});
