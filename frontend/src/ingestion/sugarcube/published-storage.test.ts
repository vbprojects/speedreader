import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { indexedDB, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import type { ReaderState } from "../../db/types";
import {
  commitPublished, loadPublished, getPublishedUsage, inspectPublishedRecovery, replacePublished,
  guardPublishedStateWrite, invalidatePublishedBudget, removePublishedInTransaction,
  PUBLISHED_BUDGET_BYTES, PUBLISHED_STORES, STORE_PUBLISHED, STORE_PUBLISHED_USAGE, STORE_PUBLISHED_BUDGET,
} from "../../db/published-storage";
import { diff, empty, snapshotBytes, entryBytes, type Snapshot, type LoadedPublished, type PublishedCommit } from "./storage-protocol";
Object.assign(globalThis, { indexedDB, IDBKeyRange });
const STATES = "readerStates", SOURCES = "interactiveSources";
const hash = (bookId: string) => `source-${bookId}`;
const scopes = [STATES, SOURCES, ...PUBLISHED_STORES];
const baseState = (bookId: string): ReaderState => ({ bookId, position: 0, lastOpenedAt: 0, settings: {} });
const batch = (bookId: string, base: LoadedPublished, next: Snapshot, revision: string): PublishedCommit => ({ sourceHash: hash(bookId), expected: base.revision, revision, delta: diff(base.snapshot, next), next });

async function fixture(t: TestContext) {
  const name = `published-test-${crypto.randomUUID()}`, connections: IDBDatabase[] = [];
  async function connect() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(STATES, { keyPath: "bookId" });
        db.createObjectStore(SOURCES, { keyPath: "bookId" });
        db.createObjectStore(STORE_PUBLISHED, { keyPath: ["bookId", "area", "key"] });
        db.createObjectStore(STORE_PUBLISHED_USAGE, { keyPath: "bookId" });
        db.createObjectStore(STORE_PUBLISHED_BUDGET, { keyPath: "id" });
      };
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    connections.push(db); return db;
  }
  t.after(async () => {
    connections.forEach(db => db.close());
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    });
  });
  return { db: await connect(), connect };
}
function write(db: IDBDatabase, update: (tx: IDBTransaction, fail: (cause: unknown) => void) => void) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(scopes, "readwrite"); let failure: unknown;
    const fail = (cause: unknown) => { failure = cause; tx.abort(); };
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure ?? tx.error ?? new Error("Aborted."));
    try { update(tx, fail); } catch (cause) { fail(cause); }
  });
}
function read<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store), request = tx.objectStore(store).get(key);
    tx.oncomplete = () => resolve(request.result as T | undefined); tx.onabort = () => reject(tx.error);
  });
}
async function seed(db: IDBDatabase, id: string, formatState?: Record<string, unknown>) {
  await write(db, tx => {
    tx.objectStore(STATES).put({ ...baseState(id), ...(formatState ? { formatState } : {}) });
    tx.objectStore(SOURCES).put({ bookId: id, sourceHash: hash(id) });
    invalidatePublishedBudget(tx);
  });
}
async function remove(db: IDBDatabase, id: string) {
  await write(db, tx => { tx.objectStore(STATES).delete(id); removePublishedInTransaction(tx, id); });
}
async function genericPatch(db: IDBDatabase, id: string, patch: Record<string, unknown>) {
  await write(db, (tx, fail) => {
    const request = tx.objectStore(STATES).get(id);
    request.onsuccess = () => {
      try {
        const before = request.result as ReaderState;
        const after = { ...before, formatState: { ...before.formatState, ...patch } };
        guardPublishedStateWrite(tx, before, after); tx.objectStore(STATES).put(after);
      } catch (cause) { fail(cause); }
    };
  });
}

// Simulate an already measured other-story balance, avoiding a 128 MiB unit-test
// value. Separate bootstrap tests below exercise accounting from actual rows.
async function addMeasuredBalance(db: IDBDatabase, bytes: number) {
  const usage = await getPublishedUsage(db, STATES);
  await write(db, tx => {
    tx.objectStore(STORE_PUBLISHED_USAGE).put({ bookId: "measured-other-stories", bytes, unknown: false });
    tx.objectStore(STORE_PUBLISHED_BUDGET).put({ id: "origin", ready: true, usedBytes: usage.usedBytes + bytes, unaccountedStories: usage.unaccountedStories });
  });
}

test("v1 migration is lossless, v2 writes only changed keys, and committed retries are idempotent", async t => {
  const { db, connect } = await fixture(t), id = "migration";
  const initial: Snapshot = { local: [["slot", "s"], ["unchanged", "u\ud800"]], session: [["state", "h"]] };
  await seed(db, id, { revision: "native", schemaVersion: 1, passage: "Start", published: { version: 1, sourceHash: hash(id), ...initial } });
  assert.equal((await getPublishedUsage(db, STATES)).usedBytes, snapshotBytes(initial));
  const base = await loadPublished(db, STATES, id, hash(id));
  assert.deepEqual(base.snapshot, initial);
  const next: Snapshot = { local: [["slot", "s2"], ["unchanged", "u\ud800"]], session: [] };
  await commitPublished(db, STATES, id, batch(id, base, next, "first"));
  const reopened = await loadPublished(await connect(), STATES, id, hash(id));
  assert.deepEqual(reopened, { revision: "first", snapshot: next });
  const updated: Snapshot = { local: [["slot", "s3"], ["unchanged", "u\ud800"]], session: [] };
  const pending = batch(id, reopened, updated, "second"), keys: string[] = [];
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
    if (this.name === STORE_PUBLISHED) keys.push((value as { key: string }).key);
    return key === undefined ? original.call(this, value) : original.call(this, value, key);
  };
  try { await commitPublished(db, STATES, id, pending); await commitPublished(db, STATES, id, pending); }
  finally { IDBObjectStore.prototype.put = original; }
  assert.deepEqual(keys, ["slot"]);
  const state = await read<ReaderState>(db, STATES, id);
  assert.equal(state?.formatState?.passage, "Start");
  assert.deepEqual(state?.formatState?.published, { version: 2, sourceHash: hash(id), order: { local: ["slot", "unchanged"], session: [] } });
  assert.equal((await getPublishedUsage(db, STATES)).usedBytes, snapshotBytes(updated));
  await assert.rejects(commitPublished(db, STATES, id, { ...pending, next }), /identity was reused/);
});

test("concurrent connections serialize CAS and deletion/reimport cannot resurrect an old revision", async t => {
  const { db, connect } = await fixture(t), other = await connect(), id = "race";
  await seed(db, id);
  const [x, y] = await Promise.all([loadPublished(db, STATES, id, hash(id)), loadPublished(other, STATES, id, hash(id))]);
  assert.ok(x.revision); assert.equal(x.revision, y.revision);
  const one = batch(id, x, { local: [["slot", "A"]], session: [] }, "a");
  const two = batch(id, y, { local: [["slot", "B"]], session: [] }, "b");
  const results = await Promise.allSettled([commitPublished(db, STATES, id, one), commitPublished(other, STATES, id, two)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const winner = await loadPublished(db, STATES, id, hash(id));
  assert.deepEqual(winner.snapshot, winner.revision === "a" ? one.next : two.next);
  await assert.rejects(commitPublished(db, STATES, id, winner.revision === "a" ? two : one), /another session/);
  await remove(db, id); await seed(db, id);
  await assert.rejects(commitPublished(db, STATES, id, batch(id, winner, empty(), "stale")), /another session/);
  const fresh = await loadPublished(other, STATES, id, hash(id));
  assert.notEqual(fresh.revision, winner.revision); assert.deepEqual(fresh.snapshot, empty());
  assert.equal((await getPublishedUsage(db, STATES)).usedBytes, 0);
});

test("mid-transaction quota failure rolls back data, manifest and origin accounting together", async t => {
  const { db, connect } = await fixture(t), id = "abort"; await seed(db, id);
  const base = await loadPublished(db, STATES, id, hash(id));
  const before = { local: [["a", "old"]], session: [["b", "old"]] } satisfies Snapshot;
  await commitPublished(db, STATES, id, batch(id, base, before, "before"));
  const saved = await loadPublished(db, STATES, id, hash(id)), usage = await getPublishedUsage(db, STATES);
  const next = { local: [["a", "new value"]], session: [["b", "new value"]] } satisfies Snapshot;
  const pending = batch(id, saved, next, "after"), original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
    if (this.name === STORE_PUBLISHED && (value as { area: string }).area === "session") throw new DOMException("simulated quota failure", "QuotaExceededError");
    return key === undefined ? original.call(this, value) : original.call(this, value, key);
  };
  try { await assert.rejects(commitPublished(db, STATES, id, pending), /simulated quota failure/); }
  finally { IDBObjectStore.prototype.put = original; }
  assert.deepEqual(await loadPublished(await connect(), STATES, id, hash(id)), saved);
  assert.deepEqual(await getPublishedUsage(db, STATES), usage);
  await commitPublished(db, STATES, id, pending);
  assert.deepEqual(await loadPublished(db, STATES, id, hash(id)), { revision: "after", snapshot: next });
});

test("oversized legacy saves remain intact for raw export until an explicit valid recovery commit", async t => {
  const { db } = await fixture(t), id = "legacy-large";
  const snapshot = { local: [["large", "x".repeat(3 * 1024 * 1024)], ["keep", "\ud800save"]], session: [] } satisfies Snapshot;
  const published = { version: 1, sourceHash: hash(id), ...snapshot };
  await seed(db, id, { revision: "old", published });
  await assert.rejects(loadPublished(db, STATES, id, hash(id)), /Original save retained/);
  assert.deepEqual(await inspectPublishedRecovery(db, STATES, id, hash(id)), { revision: "old", snapshot });
  assert.equal((await getPublishedUsage(db, STATES)).usedBytes, snapshotBytes(snapshot));
  await assert.rejects(async () => replacePublished(db, STATES, id, { sourceHash: hash(id), expected: "old", revision: "bad", snapshot }), /Invalid/);
  assert.deepEqual((await read<ReaderState>(db, STATES, id))?.formatState?.published, published);
  const selected = { local: [["keep", "\ud800save"]], session: [] } satisfies Snapshot;
  await replacePublished(db, STATES, id, { sourceHash: hash(id), expected: "old", revision: "recovered", snapshot: selected });
  assert.deepEqual(await loadPublished(db, STATES, id, hash(id)), { revision: "recovered", snapshot: selected });
  assert.equal((await getPublishedUsage(db, STATES)).usedBytes, snapshotBytes(selected));
});

test("recovery preview does not authorize overwriting a concurrently committed winner", async t => {
  const { db, connect } = await fixture(t), other = await connect(), id = "recovery-race";
  await seed(db, id, { published: { version: 1, sourceHash: hash(id), ...empty() } });
  const preview = await inspectPublishedRecovery(db, STATES, id, hash(id));
  assert.equal(preview.revision, null);
  const baseline = await loadPublished(other, STATES, id, hash(id));
  const winner: Snapshot = { local: [["slot", "winner"]], session: [] };
  await commitPublished(other, STATES, id, batch(id, baseline, winner, "winner"));
  await assert.rejects(replacePublished(db, STATES, id, { sourceHash: hash(id), expected: preview.revision, revision: "loser", snapshot: empty() }), /another session/);
  assert.deepEqual((await inspectPublishedRecovery(db, STATES, id, hash(id))).snapshot, winner);
  // Explicitly previewing the current revision permits intentional replacement.
  await replacePublished(db, STATES, id, { sourceHash: hash(id), expected: "winner", revision: "imported", snapshot: empty() });
  assert.deepEqual((await loadPublished(db, STATES, id, hash(id))).snapshot, empty());
});

test("stored source identity is checked independently for loads, export, commits and recovery", async t => {
  const { db } = await fixture(t), id = "source"; await seed(db, id);
  const base = await loadPublished(db, STATES, id, hash(id));
  const pending = batch(id, base, { local: [["slot", "new"]], session: [] }, "after");
  await write(db, tx => { tx.objectStore(SOURCES).put({ bookId: id, sourceHash: "different-source" }); });
  for (const operation of [
    () => loadPublished(db, STATES, id, hash(id)),
    () => inspectPublishedRecovery(db, STATES, id, hash(id)),
    () => commitPublished(db, STATES, id, pending),
    () => replacePublished(db, STATES, id, { sourceHash: hash(id), expected: base.revision, revision: "import", snapshot: empty() }),
  ]) await assert.rejects(operation, /source changed/);
  assert.equal((await read<ReaderState>(db, STATES, id))?.formatState?.revision, base.revision);
  await write(db, tx => { tx.objectStore(SOURCES).delete(id); });
  await assert.rejects(commitPublished(db, STATES, id, pending), /source changed/);
});

test("database validation rejects a mismatched delta/target, oversized values and reused commit identities", async t => {
  const { db } = await fixture(t), id = "validation"; await seed(db, id);
  const base = await loadPublished(db, STATES, id, hash(id));
  const desired: Snapshot = { local: [["slot", "new"]], session: [] };
  const valid = batch(id, base, desired, "new");
  await assert.rejects(commitPublished(db, STATES, id, { ...valid, delta: diff(empty(), empty()) }), /does not match/);
  const oversized: Snapshot = { local: [["slot", "x".repeat(3 * 1024 * 1024)]], session: [] };
  await assert.rejects(async () => commitPublished(db, STATES, id, batch(id, base, oversized, "large")), /Invalid/);
  await assert.rejects(commitPublished(db, STATES, id, { ...valid, expected: null }), /another session/);
  assert.deepEqual(await loadPublished(db, STATES, id, hash(id)), base);
  await commitPublished(db, STATES, id, valid);
  await assert.rejects(commitPublished(db, STATES, id, { ...valid, next: empty(), delta: diff(empty(), empty()) }), /identity was reused/);
  assert.equal((await getPublishedUsage(db, STATES)).usedBytes, snapshotBytes(desired));
});

test("legacy and v2 ledger bootstrap counts every story, including oversized and partially malformed data", async t => {
  const { db } = await fixture(t);
  const legacy: Snapshot = { local: [["old", "value"]], session: [["state", "state"]] };
  const large: Snapshot = { local: [["large", "x".repeat(3 * 1024 * 1024)]], session: [] };
  await seed(db, "legacy", { published: { version: 1, sourceHash: hash("legacy"), ...legacy } });
  await seed(db, "large", { published: { version: 1, sourceHash: hash("large"), ...large } });
  await seed(db, "broken", { published: { version: 1, sourceHash: hash("broken"), local: [["known", "value"], ["invalid", 123]], session: [] } });
  await seed(db, "new", { revision: "v2", published: { version: 2, sourceHash: hash("new"), order: { local: ["current"], session: [] } } });
  await write(db, tx => { tx.objectStore(STORE_PUBLISHED).put({ bookId: "new", area: "local", key: "current", value: "value" }); });
  const expected = snapshotBytes(legacy) + snapshotBytes(large) + entryBytes("known", "value") + entryBytes("current", "value");
  assert.deepEqual(await getPublishedUsage(db, STATES), { usedBytes: expected, limitBytes: PUBLISHED_BUDGET_BYTES, unaccountedStories: 1 });
  const current = await loadPublished(db, STATES, "new", hash("new"));
  const grown: Snapshot = { local: [["current", "longer value"]], session: [] };
  await assert.rejects(commitPublished(db, STATES, "new", batch("new", current, grown, "blocked")), /cannot be measured/);
  const shrunk: Snapshot = { local: [["current", "v"]], session: [] };
  await commitPublished(db, STATES, "new", batch("new", current, shrunk, "shrink"));
  assert.equal((await getPublishedUsage(db, STATES)).unaccountedStories, 1);
  await remove(db, "broken");
  const afterRemoval = await loadPublished(db, STATES, "new", hash("new"));
  await commitPublished(db, STATES, "new", batch("new", afterRemoval, grown, "allowed"));
  assert.equal((await getPublishedUsage(db, STATES)).unaccountedStories, 0);
  assert.deepEqual((await inspectPublishedRecovery(db, STATES, "large", hash("large"))).snapshot, large);
});

test("different stories atomically share one origin budget and rejected reservations consume nothing", async t => {
  const { db, connect } = await fixture(t), other = await connect();
  await seed(db, "a"); await seed(db, "b");
  const [a, b] = await Promise.all([loadPublished(db, STATES, "a", hash("a")), loadPublished(other, STATES, "b", hash("b"))]);
  await addMeasuredBalance(db, PUBLISHED_BUDGET_BYTES - 100);
  const next: Snapshot = { local: [["k", "v"]], session: [] };
  const results = await Promise.allSettled([
    commitPublished(db, STATES, "a", batch("a", a, next, "commit-a")),
    commitPublished(other, STATES, "b", batch("b", b, next, "commit-b")),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.name, "OriginSaveBudgetError");
  const winner = results[0].status === "fulfilled" ? "a" : "b", loser = winner === "a" ? "b" : "a";
  assert.equal((await getPublishedUsage(db, STATES)).usedBytes, PUBLISHED_BUDGET_BYTES - 100 + snapshotBytes(next));
  assert.deepEqual((await loadPublished(db, STATES, loser, hash(loser))).snapshot, empty());
  const winning = await loadPublished(db, STATES, winner, hash(winner));
  await commitPublished(db, STATES, winner, batch(winner, winning, empty(), "free-space"));
  const losing = await loadPublished(other, STATES, loser, hash(loser));
  await commitPublished(other, STATES, loser, batch(loser, losing, next, "retry"));
  assert.equal((await getPublishedUsage(db, STATES)).usedBytes, PUBLISHED_BUDGET_BYTES - 100 + snapshotBytes(next));
});

test("existing over-budget origins may shrink saves without automatic eviction", async t => {
  const { db } = await fixture(t), id = "shrinking";
  const original: Snapshot = { local: [["k", "long saved value"]], session: [] };
  await seed(db, id, { revision: "legacy", published: { version: 1, sourceHash: hash(id), ...original } });
  const base = await loadPublished(db, STATES, id, hash(id));
  await addMeasuredBalance(db, PUBLISHED_BUDGET_BYTES + 100);
  const growth: Snapshot = { local: [["k", "longer saved value than before"]], session: [] };
  await assert.rejects(commitPublished(db, STATES, id, batch(id, base, growth, "growth")), /budget is full/);
  const next: Snapshot = { local: [["k", "short"]], session: [] };
  await commitPublished(db, STATES, id, batch(id, base, next, "shrink"));
  assert.deepEqual((await loadPublished(db, STATES, id, hash(id))).snapshot, next);
  assert.equal((await getPublishedUsage(db, STATES)).usedBytes, PUBLISHED_BUDGET_BYTES + 100 + snapshotBytes(next));
  const measured = await read<{ bytes: number }>(db, STORE_PUBLISHED_USAGE, "measured-other-stories");
  assert.equal(measured?.bytes, PUBLISHED_BUDGET_BYTES + 100);
});

test("recovery can resolve the last unaccounted legacy save without a destructive preliminary reset", async t => {
  const { db } = await fixture(t), id = "unknown";
  await seed(db, id, { revision: "corrupt", published: { version: 1, sourceHash: hash(id), local: "invalid", session: [] } });
  assert.equal((await getPublishedUsage(db, STATES)).unaccountedStories, 1);
  const recovered: Snapshot = { local: [["restored", "save"]], session: [] };
  await replacePublished(db, STATES, id, { sourceHash: hash(id), expected: "corrupt", revision: "recovered", snapshot: recovered });
  assert.deepEqual(await getPublishedUsage(db, STATES), { usedBytes: snapshotBytes(recovered), limitBytes: PUBLISHED_BUDGET_BYTES, unaccountedStories: 0 });
  assert.deepEqual((await loadPublished(db, STATES, id, hash(id))).snapshot, recovered);
});

test("generic state writes invalidate legacy accounting and cannot overwrite a migrated save", async t => {
  const { db } = await fixture(t), id = "generic";
  const initial: Snapshot = { local: [["k", "short"]], session: [] };
  await seed(db, id, { revision: "legacy", published: { version: 1, sourceHash: hash(id), ...initial } });
  assert.equal((await getPublishedUsage(db, STATES)).usedBytes, snapshotBytes(initial));
  const larger: Snapshot = { local: [["k", "a longer legacy value"]], session: [] };
  await genericPatch(db, id, { published: { version: 1, sourceHash: hash(id), ...larger } });
  assert.equal((await getPublishedUsage(db, STATES)).usedBytes, snapshotBytes(larger));
  const base = await loadPublished(db, STATES, id, hash(id));
  await commitPublished(db, STATES, id, batch(id, base, larger, "migrated"));
  const migrated = await read<ReaderState>(db, STATES, id);
  await genericPatch(db, id, { published: migrated?.formatState?.published });
  assert.equal((await read<{ ready: boolean }>(db, STORE_PUBLISHED_BUDGET, "origin"))?.ready, true);
  await genericPatch(db, id, { passage: "End" });
  await assert.rejects(genericPatch(db, id, { published: { version: 1, sourceHash: hash(id), ...initial } }), /recovery or incremental/);
  assert.deepEqual((await loadPublished(db, STATES, id, hash(id))).snapshot, larger);
  assert.equal((await read<ReaderState>(db, STATES, id))?.formatState?.passage, "End");
});

test("corrupt v2 ordering is unaccounted and fails closed, while explicit removal repairs the ledger", async t => {
  const { db } = await fixture(t), id = "bad-manifest";
  await seed(db, id, { revision: "bad", published: { version: 2, sourceHash: hash(id), order: { local: ["same", "same"], session: [] } } });
  await write(db, tx => { tx.objectStore(STORE_PUBLISHED).put({ bookId: id, area: "local", key: "same", value: "save" }); });
  assert.deepEqual(await getPublishedUsage(db, STATES), { usedBytes: entryBytes("same", "save"), limitBytes: PUBLISHED_BUDGET_BYTES, unaccountedStories: 1 });
  await assert.rejects(loadPublished(db, STATES, id, hash(id)), /Invalid/);
  await remove(db, id);
  assert.deepEqual(await getPublishedUsage(db, STATES), { usedBytes: 0, limitBytes: PUBLISHED_BUDGET_BYTES, unaccountedStories: 0 });
});
