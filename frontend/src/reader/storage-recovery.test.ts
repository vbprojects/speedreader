import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMIT, entryBytes, type Snapshot } from "../ingestion/sugarcube/storage-protocol";
import { RECOVERY_LIMIT, SAVE_FILE_KIND, allRecoveryEntries, inspectRecoverySnapshot, readRecoveryDocument, readRecoveryFile, recoveryBlob, selectedRecovery, snapshotForReplacement } from "./storage-recovery";

const sourceHash = "a".repeat(64);
const blank = (): Snapshot => ({ local: [], session: [] });

test("portable export/import preserves UTF-16 strings, special keys, area scope and ordering", async () => {
  const value = "x".repeat(32767) + "😀" + "\ud800x\udfff" + "\u0000\n\r\"\\";
  const snapshot: Snapshot = { local: [["__proto__", value], ["", ""], ["constructor", "\udfff"]], session: [["__proto__", "different"]] };
  const blob = recoveryBlob(inspectRecoverySnapshot(snapshot, sourceHash));
  const restored = await readRecoveryFile(blob, sourceHash);
  assert.deepEqual(restored.snapshot, snapshot);
  assert.deepEqual(snapshotForReplacement(restored), snapshot);
  assert.equal(restored.logicalBytes.local, snapshot.local.reduce((n, [key, text]) => n + entryBytes(key, text), 0));
  assert.equal(JSON.parse(await blob.text()).kind, SAVE_FILE_KIND);
});

test("v1 recovery accepts an oversized save without pruning; explicit selection restores valid quotas", () => {
  const original: Snapshot = { local: [["slot", "ok"], ["oversized-history", "x".repeat(LIMIT.area / 2)], ["settings", "keep"]], session: [["history", "session"]] };
  const candidate = readRecoveryDocument({ version: 1, sourceHash, updatedAt: 123, ...original }, sourceHash);
  assert.equal(candidate.fitsRuntime, false);
  assert.deepEqual(candidate.snapshot, original);
  assert.throws(() => snapshotForReplacement(candidate), /still exceeds/);
  const all = allRecoveryEntries(candidate);
  assert.deepEqual([...all.local], [0, 1, 2]);
  // Selection order cannot silently change Storage.key() iteration order.
  const selected = selectedRecovery(candidate, { local: new Set([2, 0]), session: new Set([0]) });
  assert.equal(selected.fitsRuntime, true);
  assert.deepEqual(snapshotForReplacement(selected), { local: [original.local[0], original.local[2]], session: original.session });
  assert.equal(candidate.snapshot.local.length, 3);
  assert.throws(() => selectedRecovery(candidate, { local: new Set([3]), session: new Set() }), /selection/);
});

test("recovery detects excessive key count and key length without truncating stored strings", () => {
  const snapshot: Snapshot = { local: Array.from({ length: LIMIT.keys + 1 }, (_, i) => [String(i), ""]), session: [["k".repeat(LIMIT.key + 1), "preserve"]] };
  const candidate = inspectRecoverySnapshot(snapshot, sourceHash);
  assert.equal(candidate.fitsRuntime, false);
  assert.equal(candidate.violations.length, 2);
  assert.deepEqual(candidate.snapshot, snapshot);
  assert.throws(() => snapshotForReplacement(candidate));
});

test("recovery quota accounting agrees with runtime exactly at and above the area boundary", () => {
  const full = "x".repeat((LIMIT.area - entryBytes("k", "")) / 2);
  const exact = inspectRecoverySnapshot({ local: [["k", full]], session: [["s", full]] }, sourceHash);
  assert.equal(exact.logicalBytes.local, LIMIT.area);
  assert.equal(exact.fitsRuntime, true);
  assert.deepEqual(snapshotForReplacement(exact), exact.snapshot);
  assert.equal(inspectRecoverySnapshot({ local: [["k", full + "x"]], session: [] }, sourceHash).fitsRuntime, false);
});

test("file size is rejected before reading, and malformed text is never treated as an empty save", async () => {
  let reads = 0;
  for (const size of [0, -1, NaN, Infinity, 1.5, RECOVERY_LIMIT.fileBytes + 1]) {
    await assert.rejects(readRecoveryFile({ size, text: async () => { reads++; return "{}"; } }, sourceHash), /has not been read/);
  }
  assert.equal(reads, 0);
  await assert.rejects(readRecoveryFile(new Blob(["{"]), sourceHash), /not valid save JSON/);
  await assert.rejects(readRecoveryFile(new Blob(["null"]), sourceHash), /object/);
});

test("source identity, format version and structure are checked independently", () => {
  const valid = { kind: SAVE_FILE_KIND, version: 1, sourceHash, snapshot: blank() };
  assert.deepEqual(readRecoveryDocument(valid, sourceHash).snapshot, blank());
  for (const invalid of [
    { ...valid, sourceHash: "b".repeat(64) },
    { ...valid, version: 2 },
    { ...valid, kind: "foreign-format" },
    { ...valid, snapshot: { local: [["slot", "a"], ["slot", "b"]], session: [] } },
    { ...valid, snapshot: { local: [["slot", 1]], session: [] } },
    { ...valid, snapshot: { local: [["slot", "a", "extra"]], session: [] } },
    { ...valid, snapshot: { local: new Array(1), session: [] } },
    { ...valid, snapshot: { local: [], session: {} } },
  ]) assert.throws(() => readRecoveryDocument(invalid, sourceHash));
  assert.throws(() => inspectRecoverySnapshot(blank(), "not-a-source-hash"));
});

test("recovery bounds entry counts, key lengths and decoded size independently of runtime quotas", () => {
  assert.throws(() => inspectRecoverySnapshot({ local: new Array(RECOVERY_LIMIT.entriesPerArea + 1), session: [] }, sourceHash), /recovery entry limit/);
  assert.throws(() => inspectRecoverySnapshot({ local: [["k".repeat(RECOVERY_LIMIT.keyUnits + 1), ""]], session: [] }, sourceHash), /excessive key/);
  assert.throws(() => inspectRecoverySnapshot({ local: [["k", "x".repeat(RECOVERY_LIMIT.logicalBytes / 2)]], session: [] }, sourceHash), /recovery size limit/);
});

test("an explicit empty selection is valid and never changes the original", () => {
  const original = inspectRecoverySnapshot({ local: [["a", "save"]], session: [["b", "history"]] }, sourceHash);
  const selected = selectedRecovery(original, { local: new Set(), session: new Set() });
  assert.deepEqual(snapshotForReplacement(selected), blank());
  assert.deepEqual(original.snapshot, { local: [["a", "save"]], session: [["b", "history"]] });
});
