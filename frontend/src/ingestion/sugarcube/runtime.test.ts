import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { indexedDB } from "fake-indexeddb";
import { IndexedDb } from "../../db/indexeddb";
import { checkpoint, readStory, respond, restore, start, type Turn } from "./runtime";
import { registerStoryElement } from "./element-actions";
import { detectSugarCubeSource } from "./detect";

function action(turn: Turn, label: string) {
  for (const part of turn.parts) if (typeof part !== "string" && part.label === label) return part.id;
  throw new Error("Missing action " + label);
}

test("published story branches, reveals, restores committed actions and rejects a stale IndexedDB save", async () => {
  const window = new JSDOM().window;
  Object.assign(globalThis, { DOMParser: window.DOMParser, document: window.document, indexedDB });
  const bytes = readFileSync(new URL("../../../experiments/sugarcube-runtime-spike/lantern-in-the-fog.html", import.meta.url));
  const source = detectSugarCubeSource({ file: { name: "story.html", extension: "html", data: Uint8Array.from(bytes).buffer }, sourceHash: "a".repeat(64) })!.source;
  const story = readStory(source);
  let turn = start(story);
  turn = respond(story, turn, action(turn, "name"), "Sam");
  turn = respond(story, turn, action(turn, "Follow the fireflies"));
  const id = action(turn, "Pick up the silver leaf");
  turn = respond(story, turn, id);
  const db = new IndexedDb();
  await db.saveReaderState({ bookId: source.bookId, position: 0, lastOpenedAt: 0, settings: {} });
  const formatState = checkpoint(source.sourceHash, turn, [{ id }], "revision-1");
  await db.patchReaderState(source.bookId, { formatState }, null);
  await assert.rejects(db.patchReaderState(source.bookId, { formatState }, null), /another session/);
  const reopened = await new IndexedDb().getReaderState(source.bookId);
  assert.deepEqual(restore(story, source.sourceHash, reopened?.formatState).turn, turn);
  turn = respond(story, turn, action(turn, "Walk toward the distant bell"));
  assert.match(turn.parts.join(""), /Sam steps into morning/);
  assert.match(turn.parts.join(""), /carry a silver leaf/);
});

test("custom HTML actions support navigation and trusted input extensions", () => {
  Object.assign(globalThis, { document: new JSDOM().window.document });
  const remove = registerStoryElement("ask-name", () => ({ kind: "text-input", variable: "$name", label: "Name" }));
  try {
    const story = { first: "Start", passages: new Map([["Start", '<ask-name></ask-name><open-door data-passage="End">Enter</open-door>'], ["End", "Hello $name"]]) };
    let turn = start(story);
    turn = respond(story, turn, action(turn, "Name"), "Reader");
    turn = respond(story, turn, action(turn, "Enter"));
    assert.deepEqual(turn.parts, ["Hello Reader"]);
  } finally { remove(); }
});

test("arithmetic and nested conditionals preserve precedence and skip inactive branches", () => {
  const story = { first: "Start", passages: new Map([["Start",
    '<<set $n to 1 + 2 * 3>><<if $n is 1>>wrong<<elseif ($n >= 7) and not false>><<if false>><<set $n to 99>><<else>><<print $n>><</if>><<else>>wrong<</if>>',
  ]]) };
  assert.deepEqual(start(story).parts, ["7"]);
});

test("button body executes only on activation and runs before entering the destination", () => {
  const story = { first: "Start", passages: new Map([
    ["Start", '<<set $n to 1>><<button "Go" "End">><<set $n += 2>><</button>>'],
    ["End", "Count: $n"],
  ]) };
  const initial = start(story);
  assert.equal(initial.variables.$n, 1);
  assert.deepEqual(respond(story, initial, action(initial, "Go")).parts, ["Count: 3"]);
});

test("published and native checkpoints preserve each other across IndexedDB revisions", async () => {
  Object.assign(globalThis, { indexedDB });
  const db = new IndexedDb();
  const bookId = "dual-mode-story";
  await db.saveReaderState({ bookId, position: 0, lastOpenedAt: 0, settings: {} });
  const native = { passage: "Forest", variables: { $n: 2 }, schemaVersion: 1, revision: "native" };
  await db.patchReaderState(bookId, { formatState: native }, null);
  const published = { version: 1, local: [["slot", "serialized"]], session: [] };
  await db.patchReaderState(bookId, { formatState: { published, revision: "published" } }, "native");
  await assert.rejects(db.patchReaderState(bookId, { formatState: native }, "native"));
  await db.patchReaderState(bookId, { formatState: { ...native, passage: "End", revision: "later" } }, "published");
  assert.deepEqual((await new IndexedDb().getReaderState(bookId))?.formatState, {
    ...native, passage: "End", revision: "later", published,
  });
});
