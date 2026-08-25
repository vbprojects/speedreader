import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { validateInteractions } from "../../interactions/validation";
import {
  ACTIONS_BOOK_ID,
  ACTIONS_BOOK_REVISION,
  createActionsFixture,
  createActionsStream,
} from "./actions";

test("Actions is a stable, JSON-safe interactive WordStream", () => {
  const { book, stream } = createActionsFixture(123);
  equal(book.id, ACTIONS_BOOK_ID);
  equal(book.title, "Actions");
  equal(book.format, "interactive-demo");
  equal(book.builtIn, true);
  equal(book.builtInRevision, ACTIONS_BOOK_REVISION);
  equal(stream.meta.totalWords, stream.words.length);
  equal(stream.meta.isComplete, true);
  equal(stream.chapterIndex.length, 1);
  deepStrictEqual(stream.words.map((word) => word.index), stream.words.map((_, index) => index));

  const interactions = validateInteractions(stream.interactions, stream.words.length);
  deepStrictEqual(interactions.map((interaction) => interaction.boundary), [0, 16, 34, stream.words.length]);
  deepStrictEqual(
    interactions.map((interaction) => interaction.kind),
    ["continue", "text-input", "single-choice", "continue"]
  );
  ok(interactions.some((interaction) => interaction.kind === "text-input"));
  equal(interactions.find((interaction) => interaction.id === "actions:name")?.editPolicy, "mutable");
  equal(interactions.find((interaction) => interaction.id === "actions:path")?.editPolicy, "immutable");
  ok(interactions.every((interaction) => interaction.kind !== "text-input" || interaction.history?.kind === "value"));

  const roundTripped = JSON.parse(JSON.stringify(stream));
  deepStrictEqual(roundTripped, JSON.parse(JSON.stringify(stream)));
});

test("Actions fixtures are independent between reader sessions", () => {
  const first = createActionsStream();
  const second = createActionsStream();
  first.words[0].text = "Changed";
  first.interactions![0].prompt = "Changed";
  equal(second.words[0].text, "Welcome");
  equal(second.interactions![0].prompt, "A tiny interactive story is ready.");
});
