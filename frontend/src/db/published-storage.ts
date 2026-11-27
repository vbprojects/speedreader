import type { ReaderState } from "./types";
import {
  AREAS, LIMIT, empty, entryBytes, snapshotBytes, parseSnapshot, parseDelta, applyDelta, StoryRevisionConflict, LegacyStorageError,
  type Area, type LoadedPublished, type PublishedCommit, type Snapshot,
} from "../ingestion/sugarcube/storage-protocol";

export const STORE_PUBLISHED = "publishedStorage";
export const STORE_PUBLISHED_USAGE = "publishedUsage";
export const STORE_PUBLISHED_BUDGET = "publishedBudget";
export const PUBLISHED_STORES = [STORE_PUBLISHED, STORE_PUBLISHED_USAGE, STORE_PUBLISHED_BUDGET];
/** Logical published-save budget for this origin. Other origin data still consumes browser quota. */
export const PUBLISHED_BUDGET_BYTES = 128 * 1024 * 1024;
export const publishedRange = (bookId: string) => IDBKeyRange.bound([bookId], [bookId, []]);
const MAX_LEGACY_ENTRIES = 100_000;
const SOURCE_STORE = "interactiveSources";
type Row = { bookId: string; area: Area; key: string; value: string };
type Usage = { bookId: string; bytes: number; unknown: boolean };
type Ledger = { id: "origin"; ready: boolean; usedBytes: number; unaccountedStories: number };
export type PublishedStorageUsage = { usedBytes: number; limitBytes: number; unaccountedStories: number };
export type PublishedRecovery = { revision: string | null; snapshot: unknown };
export type PublishedReplacement = { sourceHash: string; expected: string | null; revision: string; snapshot: Snapshot };

export class OriginSaveBudgetError extends Error {
  constructor(message = "The saved-story budget is full. Export and explicitly remove unneeded saves, then retry.") { super(message); this.name = "OriginSaveBudgetError"; }
}
const revisionOf = (state: ReaderState | undefined) => typeof state?.formatState?.revision === "string" ? state.formatState.revision : null;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const invalid = () => new Error("Invalid published story storage.");
function metadata(state: ReaderState | undefined, sourceHash: string): Record<string, unknown> | undefined {
  const saved = state?.formatState?.published;
  if (saved === undefined) return undefined;
  if (!record(saved) || saved.sourceHash !== sourceHash || (saved.version !== 1 && saved.version !== 2)) throw new Error("Incompatible published story save.");
  return saved;
}
function assertIdentity(bookId: string, sourceHash: string) {
  if (typeof bookId !== "string" || !bookId || bookId.length > 256 || typeof sourceHash !== "string" || !sourceHash || sourceHash.length > 256) throw invalid();
}
function sameSnapshot(left: Snapshot, right: Snapshot) {
  return AREAS.every(area => left[area].length === right[area].length && left[area].every(([key, value], index) => key === right[area][index][0] && value === right[area][index][1]));
}
function fromRows(saved: Record<string, unknown>, rows: Row[]): Snapshot {
  if (rows.length > LIMIT.keys * 2 || !record(saved.order)) throw invalid();
  const order = saved.order;
  const maps = { local: new Map<string, string>(), session: new Map<string, string>() };
  for (const row of rows) {
    if (!AREAS.includes(row.area) || typeof row.key !== "string" || typeof row.value !== "string" || maps[row.area].has(row.key)) throw invalid();
    maps[row.area].set(row.key, row.value);
  }
  const result = empty();
  for (const area of AREAS) {
    const keys = order[area], values = maps[area];
    if (!Array.isArray(keys) || keys.length > LIMIT.keys || keys.length !== values.size || new Set(keys).size !== values.size || keys.some(key => typeof key !== "string" || !values.has(key))) throw invalid();
    result[area] = keys.map(key => [key, values.get(key)!]);
  }
  return parseSnapshot(result);
}
function strictSnapshot(state: ReaderState, sourceHash: string, rows: Row[]): Snapshot {
  const saved = metadata(state, sourceHash);
  if (!saved) { if (rows.length) throw invalid(); return empty(); }
  if (saved.version === 2) return fromRows(saved, rows);
  if (rows.length) throw invalid();
  try { return parseSnapshot(saved); } catch { throw new LegacyStorageError(); }
}
function scope(db: IDBDatabase, stateStore: string) {
  if (!db.objectStoreNames.contains(SOURCE_STORE)) throw new Error("The published storage schema is incomplete.");
  return [stateStore, ...PUBLISHED_STORES, SOURCE_STORE];
}
function transaction(db: IDBDatabase, stores: string[], mode: IDBTransactionMode = "readwrite") {
  try { return db.transaction(stores, mode, { durability: "strict" }); }
  catch (cause) { if (!(cause instanceof TypeError)) throw cause; return db.transaction(stores, mode); }
}
function readSource(tx: IDBTransaction, bookId: string, sourceHash: string, ready: () => void, abort: (cause: unknown) => void) {
  const request = tx.objectStore(SOURCE_STORE).get(bookId);
  request.onsuccess = () => {
    if (!record(request.result) || request.result.sourceHash !== sourceHash) abort(new Error("The imported story source changed or was removed."));
    else ready();
  };
}

/** Count legacy strings without JSON serialization or copying their values. Invalid records are never silently ignored. */
function legacyUsage(saved: unknown): { bytes: number; unknown: boolean } {
  if (!record(saved)) return { bytes: 0, unknown: true };
  if (saved.version === 2) return { bytes: 0, unknown: checkedManifest(saved) === undefined };
  if (saved.version !== 1) return { bytes: 0, unknown: true };
  let bytes = 0, unknown = typeof saved.sourceHash !== "string" || !saved.sourceHash || saved.sourceHash.length > 256;
  for (const area of AREAS) {
    const entries = saved[area];
    if (!Array.isArray(entries)) { unknown = true; continue; }
    if (entries.length > MAX_LEGACY_ENTRIES) unknown = true;
    const seen = new Set<string>();
    for (let i = 0; i < Math.min(entries.length, MAX_LEGACY_ENTRIES); i++) {
      const item: unknown = entries[i];
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || typeof item[1] !== "string") { unknown = true; continue; }
      // Duplicate legacy keys are invalid, but their serialized storage is still counted.
      if (seen.has(item[0])) unknown = true;
      seen.add(item[0]); bytes += entryBytes(item[0], item[1]);
    }
  }
  return { bytes, unknown };
}

/** Called only inside a transaction containing stateStore and all PUBLISHED_STORES. No asynchronous gaps. */
function ensureLedger(tx: IDBTransaction, stateStore: string, done: (ledger: Ledger) => void) {
  const budgets = tx.objectStore(STORE_PUBLISHED_BUDGET), usages = tx.objectStore(STORE_PUBLISHED_USAGE);
  const get = budgets.get("origin");
  get.onsuccess = () => {
    const stored = get.result as Ledger | undefined;
    if (stored?.ready && Number.isSafeInteger(stored.usedBytes) && stored.usedBytes >= 0 && Number.isSafeInteger(stored.unaccountedStories) && stored.unaccountedStories >= 0) { done(stored); return; }
    const ledger: Ledger = { id: "origin", ready: true, usedBytes: 0, unaccountedStories: 0 };
    usages.clear();
    const states = tx.objectStore(stateStore).openCursor();
    states.onsuccess = () => {
      const cursor = states.result;
      if (!cursor) { scanRows(); return; }
      const state = cursor.value as ReaderState;
      if (state.formatState?.published !== undefined) {
        const measured = legacyUsage(state.formatState.published);
        const bookId = String(cursor.primaryKey);
        usages.put({ bookId, ...measured } satisfies Usage);
        ledger.usedBytes += measured.bytes; ledger.unaccountedStories += Number(measured.unknown);
      }
      cursor.continue();
    };
    function scanRows() {
      const rows = tx.objectStore(STORE_PUBLISHED).openCursor();
      rows.onsuccess = () => {
        const cursor = rows.result;
        if (!cursor) { budgets.put(ledger); done(ledger); return; }
        const key = cursor.primaryKey;
        if (!Array.isArray(key) || typeof key[0] !== "string") { tx.abort(); return; }
        const bookId = key[0], row = cursor.value as Row;
        const previous = usages.get(bookId);
        previous.onsuccess = () => {
          const usage: Usage = previous.result ?? { bookId, bytes: 0, unknown: false };
          const measurable = row && typeof row.key === "string" && typeof row.value === "string";
          if ((!measurable || !AREAS.includes(row.area)) && !usage.unknown) { usage.unknown = true; ledger.unaccountedStories++; }
          if (measurable) { const bytes = entryBytes(row.key, row.value); usage.bytes += bytes; ledger.usedBytes += bytes; }
          usages.put(usage); cursor.continue();
        };
      };
    }
  };
}

export function invalidatePublishedBudget(tx: IDBTransaction): void {
  tx.objectStore(STORE_PUBLISHED_BUDGET).put({ id: "origin", ready: false });
}
function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || ++count > fields.length || !fields.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return false;
  }
  return count === fields.length && Object.getOwnPropertySymbols(value).length === 0;
}
function manifestKeys(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > LIMIT.keys || Object.getOwnPropertySymbols(value).length) return false;
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || ++count > value.length || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) return false;
  }
  if (count !== value.length) return false;
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return false;
    const key: unknown = descriptor.value;
    if (typeof key !== "string" || key.length > LIMIT.key || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
function checkedManifest(value: unknown): { version: 2; sourceHash: string; order: Record<Area, string[]> } | undefined {
  if (!record(value) || !exactFields(value, ["version", "sourceHash", "order"]) || value.version !== 2 || typeof value.sourceHash !== "string" || !value.sourceHash || value.sourceHash.length > 256) return;
  const order = value.order;
  if (!record(order) || !exactFields(order, AREAS) || !manifestKeys(order.local) || !manifestKeys(order.session)) return;
  return { version: 2, sourceHash: value.sourceHash, order: { local: order.local, session: order.session } };
}
function sameManifest(previous: unknown, next: unknown): boolean {
  const a = checkedManifest(previous), b = checkedManifest(next);
  return !!a && !!b && a.sourceHash === b.sourceHash && AREAS.every(area => a.order[area].length === b.order[area].length && a.order[area].every((key, index) => key === b.order[area][index]));
}
/** Ordinary reader-state paths must not resurrect a stale v1 snapshot over a migrated save. */
export function guardPublishedStateWrite(tx: IDBTransaction, before: ReaderState | undefined, after: ReaderState): void {
  const previous = before?.formatState?.published, next = after.formatState?.published;
  if (previous === next) return;
  if (record(previous) && previous.version === 2) {
    // A ReaderState read/save round trip crosses structured clone. Accept an
    // identical bounded manifest, while revision changes remain CAS-guarded by
    // the adapter. No data or accounting changed, so do not invalidate usage.
    if (!sameManifest(previous, next)) throw new Error("Published saves must be changed through the recovery or incremental save API.");
    return;
  }
  invalidatePublishedBudget(tx);
}
/** Reset/cascade owns this transaction. There is deliberately no eviction policy. */
export function removePublishedInTransaction(tx: IDBTransaction, bookId: string): void {
  tx.objectStore(STORE_PUBLISHED).delete(publishedRange(bookId));
  tx.objectStore(STORE_PUBLISHED_USAGE).delete(bookId);
  invalidatePublishedBudget(tx);
}
function budgetResult(ledger: Ledger): PublishedStorageUsage {
  return { usedBytes: ledger.usedBytes, limitBytes: PUBLISHED_BUDGET_BYTES, unaccountedStories: ledger.unaccountedStories };
}
export function getPublishedUsage(db: IDBDatabase, stateStore: string): Promise<PublishedStorageUsage> {
  return new Promise((resolve, reject) => {
    const tx = transaction(db, scope(db, stateStore)); let result: PublishedStorageUsage;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error("Could not measure saved stories."));
    ensureLedger(tx, stateStore, ledger => { result = budgetResult(ledger); });
  });
}

export function loadPublished(db: IDBDatabase, stateStore: string, bookId: string, sourceHash: string): Promise<LoadedPublished> {
  assertIdentity(bookId, sourceHash);
  return new Promise((resolve, reject) => {
    const tx = transaction(db, scope(db, stateStore)), states = tx.objectStore(stateStore);
    const state = states.get(bookId), rows = tx.objectStore(STORE_PUBLISHED).getAll(publishedRange(bookId), LIMIT.keys * 2 + 1);
    let ready = 0, result: LoadedPublished, failure: unknown;
    const abort = (cause: unknown) => { failure = cause; tx.abort(); };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("Could not load published storage."));
    tx.oncomplete = () => resolve(result);
    function loaded() {
      if (++ready !== 3) return;
      try {
        const current = state.result as ReaderState | undefined;
        if (!current) throw new StoryRevisionConflict();
        const snapshot = strictSnapshot(current, sourceHash, rows.result as Row[]);
        let revision = revisionOf(current);
        if (revision === null) {
          revision = crypto.randomUUID();
          const published = current.formatState?.published ?? { version: 2, sourceHash, order: { local: [], session: [] } };
          states.put({ ...current, formatState: { ...current.formatState, revision, published } });
          invalidatePublishedBudget(tx);
        }
        result = { revision, snapshot };
      } catch (cause) { abort(cause); }
    }
    state.onsuccess = loaded; rows.onsuccess = loaded; readSource(tx, bookId, sourceHash, loaded, abort);
  });
}

export function inspectPublishedRecovery(db: IDBDatabase, stateStore: string, bookId: string, sourceHash: string): Promise<PublishedRecovery> {
  assertIdentity(bookId, sourceHash);
  return new Promise((resolve, reject) => {
    const tx = transaction(db, scope(db, stateStore), "readonly");
    const state = tx.objectStore(stateStore).get(bookId), rows = tx.objectStore(STORE_PUBLISHED).getAll(publishedRange(bookId), LIMIT.keys * 2 + 1);
    let ready = 0, result: PublishedRecovery, failure: unknown;
    const abort = (cause: unknown) => { failure = cause; tx.abort(); };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("Could not read the original save.")); tx.oncomplete = () => resolve(result);
    function loaded() {
      if (++ready !== 3) return;
      try {
        const current = state.result as ReaderState | undefined;
        if (!current) throw new StoryRevisionConflict();
        const saved = metadata(current, sourceHash);
        // Deliberately bypass normal runtime caps for legacy recovery; UI must select and validate a replacement.
        const snapshot = saved?.version === 1 ? { local: saved.local, session: saved.session } : strictSnapshot(current, sourceHash, rows.result as Row[]);
        result = { revision: revisionOf(current), snapshot };
      } catch (cause) { abort(cause); }
    }
    state.onsuccess = loaded; rows.onsuccess = loaded; readSource(tx, bookId, sourceHash, loaded, abort);
  });
}

function checkBudget(ledger: Ledger, previous: Usage, nextBytes: number, recovery: boolean): Ledger {
  const usedBytes = ledger.usedBytes - previous.bytes + nextBytes;
  const unaccountedStories = ledger.unaccountedStories - Number(previous.unknown);
  if (!Number.isSafeInteger(usedBytes) || usedBytes < 0 || unaccountedStories < 0) throw invalid();
  const growing = nextBytes > previous.bytes;
  if (growing && (unaccountedStories > 0 || (previous.unknown && !recovery))) throw new OriginSaveBudgetError("Some old saves cannot be measured. Recover or remove them before adding saved-story data.");
  if (growing && usedBytes > PUBLISHED_BUDGET_BYTES) throw new OriginSaveBudgetError();
  return { id: "origin", ready: true, usedBytes, unaccountedStories };
}

/** Disk baseline and cumulative quotas are checked again inside the same transaction as the writes. */
export function commitPublished(db: IDBDatabase, stateStore: string, bookId: string, batch: PublishedCommit): Promise<void> {
  assertIdentity(bookId, batch.sourceHash);
  const next = parseSnapshot(batch.next), delta = parseDelta(batch.delta);
  return persist(db, stateStore, bookId, batch, next, false, (state, rows) => {
    const before = strictSnapshot(state, batch.sourceHash, rows);
    if (!sameSnapshot(applyDelta(before, delta), next)) throw new Error("The storage delta does not match its target state.");
    return delta;
  });
}
export function replacePublished(db: IDBDatabase, stateStore: string, bookId: string, replacement: PublishedReplacement): Promise<void> {
  assertIdentity(bookId, replacement.sourceHash);
  const next = parseSnapshot(replacement.snapshot);
  return persist(db, stateStore, bookId, replacement, next, true);
}
function persist(
  db: IDBDatabase, stateStore: string, bookId: string,
  batch: { sourceHash: string; expected: string | null; revision: string }, next: Snapshot, recovery: boolean,
  getDelta?: (state: ReaderState, rows: Row[]) => ReturnType<typeof parseDelta>,
): Promise<void> {
  if (typeof batch.revision !== "string" || !batch.revision || batch.revision.length > 128 || batch.revision === batch.expected || (batch.expected !== null && (typeof batch.expected !== "string" || batch.expected.length > 128))) return Promise.reject(invalid());
  return new Promise((resolve, reject) => {
    const tx = transaction(db, scope(db, stateStore)), states = tx.objectStore(stateStore), data = tx.objectStore(STORE_PUBLISHED);
    const state = states.get(bookId), rows = data.getAll(publishedRange(bookId), LIMIT.keys * 2 + 1);
    let ready = 0, failure: unknown, ledger: Ledger, usage: Usage;
    const abort = (cause: unknown) => { failure = cause; tx.abort(); };
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure ?? tx.error ?? new Error("Published storage transaction aborted."));
    function loaded() {
      if (++ready !== 4) return;
      try {
        const current = state.result as ReaderState | undefined;
        if (!current) throw new StoryRevisionConflict();
        const saved = metadata(current, batch.sourceHash);
        if (revisionOf(current) === batch.revision) {
          if (saved?.version !== 2 || !sameSnapshot(strictSnapshot(current, batch.sourceHash, rows.result as Row[]), next)) throw new Error("Commit identity was reused for different save data.");
          return;
        }
        if ((!recovery && batch.expected === null) || revisionOf(current) !== batch.expected) throw new StoryRevisionConflict();
        const delta = getDelta?.(current, rows.result as Row[]);
        const nextBytes = snapshotBytes(next), nextLedger = checkBudget(ledger, usage, nextBytes, recovery);
        if (recovery || saved?.version !== 2) {
          data.delete(publishedRange(bookId));
          for (const area of AREAS) for (const [key, value] of next[area]) data.put({ bookId, area, key, value } satisfies Row);
        } else if (delta) {
          for (const area of AREAS) {
            for (const key of delta[area].remove) data.delete([bookId, area, key]);
            for (const [key, value] of delta[area].put) data.put({ bookId, area, key, value } satisfies Row);
          }
        }
        states.put({ ...current, lastOpenedAt: Date.now(), formatState: { ...current.formatState, revision: batch.revision, published: {
          version: 2, sourceHash: batch.sourceHash, order: { local: next.local.map(([key]) => key), session: next.session.map(([key]) => key) },
        } } } satisfies ReaderState);
        tx.objectStore(STORE_PUBLISHED_USAGE).put({ bookId, bytes: nextBytes, unknown: false } satisfies Usage);
        tx.objectStore(STORE_PUBLISHED_BUDGET).put(nextLedger);
      } catch (cause) { abort(cause); }
    }
    state.onsuccess = loaded; rows.onsuccess = loaded; readSource(tx, bookId, batch.sourceHash, loaded, abort);
    ensureLedger(tx, stateStore, result => {
      ledger = result;
      const request = tx.objectStore(STORE_PUBLISHED_USAGE).get(bookId);
      request.onsuccess = () => { usage = request.result ?? { bookId, bytes: 0, unknown: false }; loaded(); };
    });
  });
}
