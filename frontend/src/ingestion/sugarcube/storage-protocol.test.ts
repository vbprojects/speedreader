import assert from "node:assert/strict";
import { test } from "node:test";
import * as p from "./storage-protocol";

const epoch = "test-epoch-00000000000001";
const requestId = "test-request-000000000001";
const blank = () => ({ put: [], remove: [] });
const delta = (local: unknown) => ({ local, session: blank() });

test("quota accounting is synchronous, UTF-16, replacement-aware, and atomic", () => {
  const area = new p.BoundedArea([]);
  const limit = (p.LIMIT.area - 64 - 2) / 2;
  const full = "x".repeat(limit);
  area.set("k", full);
  assert.throws(() => area.set("k", full + "x"), { name: "QuotaExceededError" });
  assert.equal(area.get("k"), full);
  assert.throws(() => area.set("a", ""), { name: "QuotaExceededError" });
  area.set("k", "😀");
  assert.equal(p.entryBytes("k", "😀"), 70); // two UTF-16 code units
  assert.throws(() => area.set("z".repeat(p.LIMIT.key + 1), ""), { name: "QuotaExceededError" });
  area.clear();
  for (let i = 0; i < p.LIMIT.keys; i++) area.set(String(i), "");
  assert.throws(() => area.set("extra", ""), { name: "QuotaExceededError" });
  area.remove("0"); area.set("extra", "");
  assert.equal(area.size, p.LIMIT.keys);
});

test("diff preserves deletion, replacement, reinsertion order and scope isolation", () => {
  const before: p.Snapshot = { local: [["a", "1"], ["b", "2"], ["c", "3"]], session: [["a", "session"]] };
  const after: p.Snapshot = { local: [["c", "3"], ["a", "1"], ["new", "4"]], session: [] };
  const d = p.diff(before, after);
  assert.deepEqual(d.local.put, [["new", "4"]]);
  assert.deepEqual(d.local.order, ["c", "a", "new"]);
  assert.deepEqual(p.applyDelta(before, p.parseDelta(d)), after);
  assert.equal(p.hasChanges(p.diff(after, after)), false);
  assert.equal(p.snapshotBytes(after), after.local.reduce((n, [k, v]) => n + p.entryBytes(k, v), 0));
});

test("parent rejects oversized, duplicate, conflicting, malformed and cumulative-overquota deltas", () => {
  for (const local of [
    { put: [["a", "x".repeat(p.LIMIT.area)]], remove: [] },
    { put: [["a", "x"], ["a", "y"]], remove: [] },
    { put: [["a", "x"]], remove: ["a"] },
    { put: [], remove: Array(p.LIMIT.keys + 1).fill("a") },
    { put: [["a", {}]], remove: [] },
    { put: [["a", "value", "extra"]], remove: [] },
    { put: [], remove: [], extra: "hidden" },
    { put: [], remove: [], order: ["a", "a"] },
  ]) assert.throws(() => p.parseDelta(delta(local)), p.StoryProtocolError);
  const before: p.Snapshot = { local: [["a", "x".repeat((p.LIMIT.area - 66) / 2)]], session: [] };
  assert.throws(() => p.applyDelta(before, p.parseDelta(delta({ put: [["b", "x"]], remove: [] }))));
  assert.throws(() => p.applyDelta(before, p.parseDelta(delta({ put: [], remove: [], order: ["wrong"] }))));
  assert.throws(() => p.applyDelta(before, p.parseDelta(delta({ put: [], remove: ["absent"] }))));
  assert.throws(() => p.parseSnapshot({ local: [["a", "1"], ["a", "2"]], session: [] }));
  assert.deepEqual(p.parseSnapshot({ version: 1, revision: "legacy", local: [], session: [] }), p.empty());
});

test("parsers reject sparse arrays, properties, prototypes and accessors without executing getters", () => {
  let read = false;
  const getterPair = ["a", "value"];
  Object.defineProperty(getterPair, "1", { get() { read = true; throw new Error("must not execute"); } });
  const sparsePair = new Array(2); sparsePair[0] = "a";
  const extended = [["a", "v"]]; Object.defineProperty(extended, "hidden", { value: true });
  const symbolArray = [["a", "v"]]; Object.defineProperty(symbolArray, Symbol.iterator, { value() { throw new Error("must not execute"); } });
  const customPrototype = Object.setPrototypeOf([["a", "v"]], Object.create(Array.prototype));
  for (const local of [new Array(2), [sparsePair], [getterPair], extended, symbolArray, customPrototype]) {
    assert.throws(() => p.parseSnapshot({ local, session: [] }), p.StoryProtocolError);
  }
  const packet = { v: 2, epoch, type: "ack", seq: 1 };
  Object.defineProperty(packet, "seq", { get() { read = true; return 1; } });
  assert.throws(() => p.parseParentMessage(packet, epoch), p.StoryProtocolError);
  assert.equal(read, false);
  assert.throws(() => p.parseSnapshot(Object.assign([], p.empty())), p.StoryProtocolError);
});

test("both endpoints require exact bounded envelopes with protocol version and epoch", () => {
  const valid = p.envelope(epoch, { type: "ack", seq: 1 });
  assert.deepEqual(p.parseParentMessage(valid, epoch), valid);
  for (const packet of [
    { ...valid, v: 1 }, { ...valid, epoch: "other-epoch-0000000000001" },
    { ...valid, seq: 0 }, { ...valid, seq: -1 }, { ...valid, seq: 1.5 },
    { ...valid, seq: Infinity }, { ...valid, seq: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, extra: true }, { type: "ack", seq: 1 }, Object.assign([], valid),
    p.envelope(epoch, { type: "export", requestId: "short" }),
  ]) assert.throws(() => p.parseParentMessage(packet, epoch), p.StoryProtocolError);
  assert.throws(() => p.parseParentMessage(Object.defineProperty({ ...valid }, "hidden", { value: true }), epoch));
  for (const type of ["flush", "drain", "pause", "resume"] as const) {
    assert.deepEqual(p.parseParentMessage(p.envelope(epoch, { type }), epoch), p.envelope(epoch, { type }));
    assert.throws(() => p.parseParentMessage(p.envelope(epoch, { type, seq: 1 } as p.ParentPayload), epoch));
  }
  assert.throws(() => p.envelope("invalid.token.too.long", { type: "pause" }));
  assert.throws(() => p.parseFrameMessage(p.envelope(epoch, { type: "error", message: "x".repeat(p.LIMIT.error + 1) }), epoch));
  assert.throws(() => p.parseFrameMessage(p.envelope(epoch, { type: "delta", seq: 0, delta: delta(blank()) } as p.FramePayload), epoch));
  assert.throws(() => p.parseFrameMessage({ ...p.envelope(epoch, { type: "started" }), payload: "junk" }, epoch));
  assert.throws(() => p.parseFrameMessage(p.envelope(epoch, { type: "exported", requestId, snapshot: { ...p.empty(), extra: true } } as p.FramePayload), epoch));
  assert.deepEqual(p.parseFrameMessage(p.envelope(epoch, { type: "exported", requestId, snapshot: p.empty() }), epoch),
    p.envelope(epoch, { type: "exported", requestId, snapshot: p.empty() }));
});

test("large correlated values use bounded reversible UTF-16 patches, unrelated values fall back", () => {
  const original = "a".repeat(25000) + "\ud800" + "b".repeat(25000);
  const replacement = "a".repeat(25000) + "\udc00" + "b".repeat(25000);
  const before: p.Snapshot = { local: [["slot", original], ["other", "unchanged"]], session: [] };
  for (const changed of [replacement, original + "append", original.slice(0, 30000), "z".repeat(original.length)]) {
    const after: p.Snapshot = { local: [["other", "unchanged"], ["slot", changed]], session: [] };
    const wire = p.encodeDelta(before, after);
    assert.deepEqual(p.applyDelta(before, p.decodeDelta(before, wire)), after);
    if (changed.startsWith("z")) { assert.equal(wire.local.patches, undefined); assert.equal(wire.local.put.length, 1); }
    else { assert.equal(wire.local.patches?.length, 1); assert.equal(wire.local.put.length, 0); }
  }
  assert.equal(p.encodeDelta({ local: [["s", "x".repeat(100)]], session: [] }, { local: [["s", "x".repeat(99) + "y"]], session: [] }).local.patches, undefined);
});

test("patches cannot expand beyond area quota, overlap edits, or select an absent/stale base", () => {
  const patch = { key: "slot", oldLength: 20000, prefix: 10000, suffix: 9999, value: "x" };
  const wire = (patches: unknown, put: unknown[] = [], remove: string[] = []) => delta({ put, remove, patches });
  const before: p.Snapshot = { local: [["slot", "a".repeat(20000)]], session: [] };
  for (const bad of [
    { ...patch, oldLength: 19999 }, { ...patch, prefix: 20000, suffix: 1 },
    { ...patch, prefix: -1 }, { ...patch, suffix: 1.2 }, { ...patch, key: "missing" },
    { ...patch, value: "a".repeat(p.LIMIT.area / 2) },
    { ...patch, unknown: true }, { ...patch, oldLength: Number.MAX_SAFE_INTEGER },
  ]) assert.throws(() => p.decodeDelta(before, wire([bad])), p.StoryProtocolError);
  assert.throws(() => p.decodeDelta(before, wire([patch, patch])), p.StoryProtocolError);
  assert.throws(() => p.decodeDelta(before, wire([patch], [["slot", "v"]])), p.StoryProtocolError);
  assert.throws(() => p.decodeDelta(before, wire([patch], [], ["slot"])), p.StoryProtocolError);
  const hugePatch = { key: "slot", oldLength: 1500000, prefix: 1500000, suffix: 0, value: "" };
  assert.throws(() => p.decodeDelta(before, wire([hugePatch, { ...hugePatch, key: "other" }])), p.StoryProtocolError);
  assert.throws(() => p.parseDelta(wire([patch])), p.StoryProtocolError); // DB accepts expanded values only.
});
