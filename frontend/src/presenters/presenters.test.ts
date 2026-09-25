import { test } from "node:test";
import assert from "node:assert/strict";
import { textToStream } from "../ingestion/text";
import { appendToWordStream } from "../ingestion/interactive";
import { epubBlocks, validateBlocks } from "./blocks";
import { PresenterRegistry, presenters } from "./registry";
import type { PresenterOutput } from "./types";

test("layouts preserve canonical words and legacy EPUB paragraphs never guess headings", async () => {
  const stream = textToStream("First paragraph.\n\nSecond paragraph.");
  const original = structuredClone(stream);
  const pipeline = presenters.open({ layout: "book-layout", behaviors: [] }, ["epub"]);
  const first = await pipeline.update(stream), second = await pipeline.update(stream);
  assert.equal(first.stream.words, stream.words);
  assert.deepEqual(stream, original);
  assert.deepEqual(first, second);
  assert.ok(first.layouts.every(block => block.kind === "paragraph"));
  assert.deepEqual(epubBlocks({ ...stream, words: stream.words.map(word => ({ ...word, metadata: [] })) }), []);
  pipeline.dispose();
});
test("blocks append once with stable identities and reject collisions and invalid ranges", () => {
  const a = textToStream("one two");
  a.blocks = [{ id: "one", sourceRef: "source:one", kind: "post", start: 0, end: 2 }];
  const b = appendToWordStream(a, textToStream("three four").words, {
    blocks: [{ id: "two", sourceRef: "source:two", kind: "post", start: 0, end: 2 }],
  });
  assert.deepEqual(b.blocks?.map(block => [block.id, block.start, block.end]), [["one",0,2],["two",2,4]]);
  assert.throws(() => appendToWordStream(a, a.words, { blocks: a.blocks }), /Invalid/);
  assert.throws(() => validateBlocks([{ ...a.blocks![0], end: 3 }], 2));
});
test("fixture behavior owns chapter actions while source actions remain unchanged", async () => {
  const registry = new PresenterRegistry();
  const delivered: string[] = [];
  registry.register({ manifest: { id: "review", version: 1, label: "Review", role: "behavior", capabilities: [] },
    open: () => ({
      update: stream => ({ interactions: [{ schemaVersion: 1, id: "chapter", kind: "continue", boundary: stream.words.length }],
        triggers: [{ schemaVersion: 1, id: "prepare", kind: "engine-trigger", boundary: 0, signal: { type: "prepare" } }] }),
      handleEvent: event => { delivered.push(event.kind === "trigger" ? event.triggerId : event.interactionId); }, dispose() {},
    }) });
  const pipeline = registry.open({ layout: "standard", behaviors: ["review"] }, []);
  const stream = textToStream("A chapter.");
  stream.interactions = [{ schemaVersion: 1, id: "source-action", kind: "continue", boundary: 0 }];
  const output = await pipeline.update(stream);
  assert.equal(output.stream.interactions?.[0], stream.interactions[0]);
  const event = { schemaVersion: 1 as const, eventId: "event", kind: "interaction-response" as const,
    interactionId: "presenter:review:chapter", boundary: 2, position: 2,
    response: { schemaVersion: 1 as const, kind: "continue" as const, interactionId: "presenter:review:chapter" } };
  assert.equal(await pipeline.handleEvent(event), true);
  assert.deepEqual(delivered, ["chapter"]);
  assert.equal(await pipeline.handleEvent({ ...event, interactionId: "source-action" }), false);
  assert.equal((await pipeline.update(stream)).stream.interactions?.length, 2);
  pipeline.dispose();
  assert.equal(await pipeline.handleEvent(event), false);
});
test("late work is cancelled when superseded or disposed", async () => {
  const registry = new PresenterRegistry();
  const pending: { resolve(value: PresenterOutput): void; signal: AbortSignal }[] = [];
  let disposed = 0;
  registry.register({ manifest: { id: "slow", version: 1, label: "Slow", role: "behavior", capabilities: [] },
    open: () => ({ update: (_, signal) => new Promise(resolve => pending.push({ resolve, signal })), dispose() { disposed++; } }) });
  const pipeline = registry.open({ layout: "standard", behaviors: ["slow"] }, []);
  const first = pipeline.update(textToStream("one"));
  const firstRejected = assert.rejects(first, /cancelled/);
  const second = pipeline.update(textToStream("two"));
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve({}); await firstRejected;
  pipeline.dispose();
  const secondRejected = assert.rejects(second, /cancelled/);
  pending[1].resolve({}); await secondRejected;
  assert.equal(disposed, 1);
});
test("unknown, incompatible and duplicate selections fail without altering source", () => {
  assert.throws(() => presenters.open({ layout: "book-layout", behaviors: [] }, ["posts"]));
  assert.throws(() => presenters.open({ layout: "missing", behaviors: [] }, []));
  assert.throws(() => presenters.open({ layout: "post-cards", behaviors: ["post-cards"] }, ["posts"]));
});

test("disposal prevents late event acknowledgements and is idempotent", async () => {
  let finish!: () => void;
  let disposals = 0;
  const registry = new PresenterRegistry();
  registry.register({ manifest: { id: "events", version: 1, role: "behavior", label: "Events", capabilities: [] },
    open: () => ({ update: () => ({ triggers: [{ schemaVersion: 1, id: "prepare", kind: "engine-trigger", boundary: 0, signal: { type: "prepare" } }] }),
      handleEvent: () => new Promise<void>(resolve => { finish = resolve; }), dispose() { disposals++; } }) });
  const pipeline = registry.open({ layout: "standard", behaviors: ["events"] }, []);
  const stream = textToStream("word");
  await pipeline.update(stream);
  const pending = pipeline.handleEvent({ schemaVersion: 1, eventId: "one", kind: "trigger",
    triggerId: "presenter:events:prepare", signal: { type: "prepare" }, boundary: 0, position: 0 });
  pipeline.dispose(); pipeline.dispose();
  const rejected = assert.rejects(pending, /cancelled/); finish(); await rejected;
  assert.equal(disposals, 1);
  await assert.rejects(pipeline.update(stream), /disposed/);
});
