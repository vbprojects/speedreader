import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { IndexedDb } from "./indexeddb";
import type { ReaderState, StoredInteractiveSource } from "./types";
import { diff, empty, snapshotBytes, type LoadedPublished, type Snapshot } from "../ingestion/sugarcube/storage-protocol";

const id = "published-adapter-story";
const source: StoredInteractiveSource = {
  bookId: id, sourceHash: id, schemaVersion: 1, format: "sugarcube-2-runtime", mimeType: "text/html", html: "<html></html>",
  story: { title: "Story", ifid: "test", startNode: "1" },
};
const state = (): ReaderState => ({ bookId: id, position: 0, lastOpenedAt: 0, settings: {} });
const snapshot = (value: string): Snapshot => ({ local: [["save", value], ["preferences", "p"]], session: [["state", "turn"]] });
const batch = (base: LoadedPublished, next: Snapshot, revision: string) => ({ sourceHash: id, expected: base.revision, revision, delta: diff(base.snapshot, next), next });
async function fixture(t: TestContext, withSource = true) {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: IDBKeyRange });
  const db = new IndexedDb();
  if (withSource) await db.saveInteractiveSource(source);
  await db.saveReaderState(state());
  t.after(() => db.deleteBookCascade(id));
  return db;
}
async function saved(db: IndexedDb) {
  const base = await db.loadPublishedStorage(id, id), next = snapshot("published save");
  await db.commitPublishedStorage(id, batch(base, next, "published"));
  return { revision: "published", snapshot: next };
}

test("generic checkpoints preserve published storage while native CAS updates remain compatible", async t => {
  const db = await fixture(t);
  await db.patchReaderState(id, { formatState: { revision: "native-start", schemaVersion: 1, passage: "Start" } }, null);
  const base = await saved(db);
  await db.saveReaderState({ ...state(), position: 27, settings: { wpm: 420 } });
  await db.patchReaderState(id, { formatState: { passage: "Middle" }, lastOpenedAt: 9 });
  const checkpoint = await db.getReaderState(id);
  assert.equal(checkpoint?.position, 27); assert.equal(checkpoint?.settings.wpm, 420);
  assert.equal(checkpoint?.formatState?.revision, "published"); assert.equal(checkpoint?.formatState?.passage, "Middle");
  assert.deepEqual(await db.loadPublishedStorage(id, id), base);
  await db.patchReaderState(id, { formatState: { revision: "native-later", passage: "End" } }, "published");
  assert.deepEqual(await db.loadPublishedStorage(id, id), { revision: "native-later", snapshot: base.snapshot });
  await assert.rejects(db.commitPublishedStorage(id, batch(base, snapshot("stale"), "stale")), /another session/);
  assert.equal((await db.getPublishedStorageUsage()).usedBytes, snapshotBytes(base.snapshot));
});

test("generic read/save round trips are compatible while revision and manifest changes remain fenced", async t => {
  const db = await fixture(t), base = await saved(db), before = await db.getReaderState(id);
  assert.ok(before);
  await assert.rejects(db.patchReaderState(id, { formatState: { revision: "unfenced" } }), /expected revision/);
  await assert.rejects(db.saveReaderState({ ...before, formatState: { ...before.formatState, revision: "unfenced" } }), /expected revision/);
  await assert.rejects(db.patchReaderState(id, { formatState: { revision: "stale" } }, "older"), /another session/);
  await db.saveReaderState(before);
  assert.deepEqual(await db.getReaderState(id), before);
  const manifest = before.formatState?.published as { version: number; sourceHash: string; order: { local: string[]; session: string[] } };
  await assert.rejects(db.patchReaderState(id, { formatState: { published: { ...manifest, sourceHash: "different-source" } } }, "published"), /recovery or incremental/);
  await assert.rejects(db.patchReaderState(id, { formatState: { published: { ...manifest, order: { ...manifest.order, local: [...manifest.order.local].reverse() } } } }, "published"), /recovery or incremental/);
  await assert.rejects(db.patchReaderState(id, { formatState: { published: { ...manifest, order: { local: ["different-key"], session: ["state"] } } } }, "published"), /recovery or incremental/);
  await assert.rejects(db.patchReaderState(id, { formatState: { published: { ...manifest, extra: "unaccounted" } } }, "published"), /recovery or incremental/);
  const stale = { version: 1, sourceHash: id, ...empty() };
  await assert.rejects(db.patchReaderState(id, { formatState: { published: stale } }, "published"), /recovery or incremental/);
  await assert.rejects(db.patchReaderState(id, { formatState: { published: undefined } }, "published"), /recovery or incremental/);
  assert.deepEqual(await db.loadPublishedStorage(id, id), base);
  assert.deepEqual(await db.getReaderState(id), before);
});

test("native and published writers compete on the same durable revision", async t => {
  const db = await fixture(t), other = new IndexedDb(), before = await saved(db), next = snapshot("changed");
  const results = await Promise.allSettled([
    db.patchReaderState(id, { formatState: { revision: "native-winner", passage: "New native turn" } }, before.revision),
    other.commitPublishedStorage(id, batch(before, next, "published-winner")),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const reopened = await db.loadPublishedStorage(id, id);
  assert.deepEqual(reopened.snapshot, results[0].status === "fulfilled" ? before.snapshot : next);
  assert.equal(reopened.revision, results[0].status === "fulfilled" ? "native-winner" : "published-winner");
  assert.equal((await db.getPublishedStorageUsage()).usedBytes, snapshotBytes(reopened.snapshot));
});

test("adapter wrappers reject missing or replaced sources and reset/cascade release accounting", async t => {
  const db = await fixture(t, false);
  await assert.rejects(db.loadPublishedStorage(id, id), /source changed/);
  await assert.rejects(db.inspectPublishedRecovery(id, id), /source changed/);
  await assert.rejects(db.replacePublishedStorage(id, { sourceHash: id, expected: null, revision: "missing", snapshot: empty() }), /source changed/);
  await db.saveInteractiveSource(source);
  const before = await saved(db);
  await db.saveInteractiveSource({ ...source, sourceHash: "replacement" });
  await assert.rejects(db.commitPublishedStorage(id, batch(before, snapshot("stale"), "stale")), /source changed/);
  await db.saveInteractiveSource(source);
  await db.deleteReaderState(id);
  assert.equal((await db.getPublishedStorageUsage()).usedBytes, 0);
  await db.saveReaderState(state());
  await assert.rejects(db.commitPublishedStorage(id, batch(before, empty(), "old-session")), /another session/);
  const fresh = await db.loadPublishedStorage(id, id); assert.notEqual(fresh.revision, before.revision);
  await db.commitPublishedStorage(id, batch(fresh, snapshot("new session"), "new-session"));
  await db.deleteBookCascade(id);
  assert.equal(await db.getReaderState(id), null); assert.equal(await db.getInteractiveSource(id), null);
  assert.equal((await db.getPublishedStorageUsage()).usedBytes, 0);
});

test("legacy fixture/import writes invalidate accounting and recovery replacement is revision-guarded", async t => {
  const db = await fixture(t), initial = snapshot("legacy");
  await db.patchReaderState(id, { formatState: { revision: "old", published: { version: 1, sourceHash: id, ...initial } } }, null);
  assert.equal((await db.getPublishedStorageUsage()).usedBytes, snapshotBytes(initial));
  const oversized: Snapshot = { local: [["huge", "x".repeat(3 * 1024 * 1024)], ["keep", "save"]], session: [] };
  await db.patchReaderState(id, { formatState: { published: { version: 1, sourceHash: id, ...oversized }, revision: "legacy-large" } }, "old");
  assert.equal((await db.getPublishedStorageUsage()).usedBytes, snapshotBytes(oversized));
  await assert.rejects(db.loadPublishedStorage(id, id), /Original save retained/);
  const raw = await db.inspectPublishedRecovery(id, id);
  assert.deepEqual(raw, { revision: "legacy-large", snapshot: oversized });
  await assert.rejects(db.replacePublishedStorage(id, { sourceHash: id, expected: "old", revision: "stale-import", snapshot: initial }), /another session/);
  const selected: Snapshot = { local: [["keep", "save"]], session: [] };
  await db.replacePublishedStorage(id, { sourceHash: id, expected: raw.revision, revision: "recovered", snapshot: selected });
  assert.deepEqual(await new IndexedDb().loadPublishedStorage(id, id), { revision: "recovered", snapshot: selected });
  assert.equal((await db.getPublishedStorageUsage()).usedBytes, snapshotBytes(selected));
});
