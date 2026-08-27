import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { buildReaderFlowRange } from "./flow";
import type { ReaderInteraction } from "./types";
import type { HtmlPresentation } from "../presentation/types";

const words = [0, 1, 2].map((index) => ({ text: `w${index}`, index, metadata: [] }));
const interaction = (id: string, boundary: number): ReaderInteraction => ({ schemaVersion: 1, id, boundary, kind: "continue" });

test("flow places boundary actions before the following word and retains the final action", () => {
    const nodes = buildReaderFlowRange(words, [interaction("start", 0), interaction("middle", 2), interaction("end", 3)]);
    deepStrictEqual(nodes.map((node) => node.kind === "word" ? node.word.text : node.kind === "interaction" ? node.interaction.id : node.presentation.id), ["start", "w0", "w1", "middle", "w2", "end"]);
});

test("flow preserves declaration order for actions at one boundary", () => {
    const nodes = buildReaderFlowRange(words, [interaction("a", 1), interaction("b", 1)]);
    deepStrictEqual(nodes.filter((node) => node.kind === "interaction").map((node) => node.kind === "interaction" && node.interaction.id), ["a", "b"]);
});

test("flow projects inert presentations without consuming a word", () => {
    const presentations: HtmlPresentation[] = [
      { schemaVersion: 1, id: "card", boundary: 1, kind: "html", html: "<p>Card</p>" },
      { schemaVersion: 1, id: "end", boundary: 3, kind: "html", html: "<hr>" },
    ];
    const nodes = buildReaderFlowRange(words, [interaction("pause", 1)], [], 0, words.length, presentations);
    deepStrictEqual(
      nodes.map((node) => node.kind === "word" ? node.word.text : node.kind === "interaction" ? node.interaction.id : node.presentation.id),
      ["w0", "card", "pause", "w1", "w2", "end"]
    );
    deepStrictEqual(nodes.filter((node) => node.kind === "word").map((node) => node.kind === "word" && node.word.index), [0, 1, 2]);
});

test("flow selects a small visible range from a large sorted history", () => {
    const longWords = Array.from({ length: 30_000 }, (_, index) => ({ text: `w${index}`, index, metadata: [] }));
    const interactions = Array.from({ length: 30_000 }, (_, boundary) => interaction(`i${boundary}`, boundary));
    const presentations: HtmlPresentation[] = Array.from({ length: 30_000 }, (_, boundary) => ({
      schemaVersion: 1,
      id: `p${boundary}`,
      boundary,
      kind: "html",
      html: "<hr>",
    }));
    const nodes = buildReaderFlowRange(longWords, interactions, [], 29_995, 30_000, presentations);
    deepStrictEqual(nodes.filter((node) => node.kind === "word").map((node) => node.kind === "word" && node.word.index), [29_995, 29_996, 29_997, 29_998, 29_999]);
    deepStrictEqual(nodes.slice(0, 3).map((node) => node.kind), ["presentation", "interaction", "word"]);
});
