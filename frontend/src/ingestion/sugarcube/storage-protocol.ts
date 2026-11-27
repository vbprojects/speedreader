// Dependency-free: the app imports this module and Vite also inlines it into the
// opaque story document. No runtime imports or exposed globals are required.
export type Entries = [string, string][];
export type Area = "local" | "session";
export type Snapshot = Record<Area, Entries>;
export type AreaDelta = { put: Entries; remove: string[]; order?: string[] };
export type Delta = Record<Area, AreaDelta>;
export type ValuePatch = { key: string; oldLength: number; prefix: number; suffix: number; value: string };
export type WireAreaDelta = AreaDelta & { patches?: ValuePatch[] };
export type WireDelta = Record<Area, WireAreaDelta>;
export const AREAS = ["local", "session"] as const;
export const PROTOCOL_VERSION = 2 as const;
export const LIMIT = { area: 5 * 1024 * 1024, keys: 1024, key: 2048, wire: 32 * 1024 * 1024, token: 128, error: 512 } as const;
export const empty = (): Snapshot => ({ local: [], session: [] });
export class StoryRevisionConflict extends Error {
  constructor() { super("This story changed in another session. Reopen it to load the latest save."); this.name = "StoryRevisionConflict"; }
}
export class LegacyStorageError extends Error {
  constructor() { super("Legacy published save exceeds the new limits or is invalid. Original save retained; export it before migrating."); this.name = "LegacyStorageError"; }
}
export class StoryProtocolError extends Error {
  constructor() { super("Invalid SugarCube storage message."); this.name = "StoryProtocolError"; }
}
const quota = () => new DOMException("Story storage quota exceeded", "QuotaExceededError");
const invalid = () => new StoryProtocolError();
export const entryBytes = (k: string, v: string) => 64 + 2 * (k.length + v.length);
export const snapshotBytes = (snapshot: Snapshot) => AREAS.reduce((total, area) => total + snapshot[area].reduce((n, [k, v]) => n + entryBytes(k, v), 0), 0);
function record(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw invalid();
  const prototype = Object.getPrototypeOf(x);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  return x as Record<string, unknown>;
}
function own(r: object, name: string): unknown {
  const d = Object.getOwnPropertyDescriptor(r, name);
  if (!d || !("value" in d)) throw invalid();
  return d.value;
}
function optional(r: object, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(r, name) ? own(r, name) : undefined;
}
function fields(r: object, allowed: readonly string[]) {
  // Reject excess fields without allocating a potentially enormous Object.keys.
  let n = 0;
  for (const k in r) {
    if (!Object.prototype.hasOwnProperty.call(r, k) || ++n > allowed.length || !allowed.includes(k)) throw invalid();
    own(r, k); // Reject accessors even in direct calls outside structured clone.
  }
  // Structured clone drops non-enumerable properties; reject them as well when
  // this parser is called directly by migration/import code or tests.
  const names = Object.getOwnPropertyNames(r);
  if (names.length > allowed.length || names.some(k => !allowed.includes(k)) || Object.getOwnPropertySymbols(r).length) throw invalid();
  for (const name of names) own(r, name);
}
function key(x: unknown): string {
  if (typeof x !== "string" || x.length > LIMIT.key) throw invalid();
  return x;
}
function list(x: unknown, limit: number = LIMIT.keys): unknown[] {
  if (!Array.isArray(x) || x.length > limit) throw invalid();
  const prototype = Object.getPrototypeOf(x);
  if (prototype !== Array.prototype) throw invalid();
  let n = 0;
  for (const k in x) {
    if (!Object.prototype.hasOwnProperty.call(x, k) || ++n > x.length || !/^(0|[1-9]\d*)$/.test(k) || Number(k) >= x.length) throw invalid();
  }
  if (Object.getOwnPropertySymbols(x).length || n !== x.length || Object.getOwnPropertyNames(x).length !== x.length + 1) throw invalid();
  for (let i = 0; i < x.length; i++) own(x, String(i));
  return x;
}
function entries(x: unknown): Entries {
  let bytes = 0;
  const seen = new Set<string>(), result: Entries = [];
  for (const item of list(x)) {
    const pair = list(item, 2);
    if (pair.length !== 2 || typeof pair[1] !== "string") throw invalid();
    const k = key(pair[0]), v = pair[1];
    bytes += entryBytes(k, v);
    if (bytes > LIMIT.area || seen.has(k)) throw invalid();
    seen.add(k); result.push([k, v]);
  }
  return result;
}
function keys(x: unknown): string[] {
  const result = list(x).map(key);
  if (new Set(result).size !== result.length) throw invalid();
  return result;
}
export function parseSnapshot(x: unknown): Snapshot {
  // v1 manifests and launch packets also use this parser: discard their metadata.
  const r = record(x);
  return { local: entries(own(r, "local")), session: entries(own(r, "session")) };
}
export function parseDelta(x: unknown): Delta {
  const delta = parseWireDelta(x);
  if (AREAS.some(a => delta[a].patches?.length)) throw invalid();
  return delta;
}
function integer(x: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0 || x > max) throw invalid();
  return x;
}
function parseWireDelta(x: unknown): WireDelta {
  const r = record(x); fields(r, AREAS);
  let bytes = 0;
  function count(n: number) { bytes += n; if (bytes > LIMIT.wire) throw invalid(); }
  function area(x: unknown): WireAreaDelta {
    const a = record(x); fields(a, ["put", "remove", "order", "patches"]);
    const put = entries(own(a, "put")), remove = keys(own(a, "remove"));
    const orderValue = optional(a, "order"), patchValue = optional(a, "patches");
    const order = orderValue === undefined ? undefined : keys(orderValue);
    const seen = new Set(remove);
    const patches: ValuePatch[] = [];
    let expandedBytes = 0;
    for (const [k, v] of put) {
      if (seen.has(k)) throw invalid();
      seen.add(k); count(entryBytes(k, v)); expandedBytes += entryBytes(k, v);
    }
    for (const item of patchValue === undefined ? [] : list(patchValue)) {
      const patch = record(item); fields(patch, ["key", "oldLength", "prefix", "suffix", "value"]);
      const k = key(own(patch, "key")), value = own(patch, "value");
      if (typeof value !== "string" || value.length > LIMIT.area / 2 || seen.has(k)) throw invalid();
      const oldLength = integer(own(patch, "oldLength"), LIMIT.area / 2);
      const prefix = integer(own(patch, "prefix"), oldLength), suffix = integer(own(patch, "suffix"), oldLength);
      if (prefix + suffix > oldLength || 64 + 2 * (k.length + prefix + suffix + value.length) > LIMIT.area) throw invalid();
      expandedBytes += 64 + 2 * (k.length + prefix + suffix + value.length);
      if (expandedBytes > LIMIT.area) throw invalid();
      seen.add(k); count(32 + entryBytes(k, value));
      patches.push({ key: k, oldLength, prefix, suffix, value });
    }
    if (put.length + patches.length > LIMIT.keys) throw invalid();
    for (const k of remove) count(64 + 2 * k.length);
    for (const k of order ?? []) count(64 + 2 * k.length);
    return { put, remove, ...(order === undefined ? {} : { order }), ...(patches.length ? { patches } : {}) };
  }
  return { local: area(own(r, "local")), session: area(own(r, "session")) };
}
const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);
export function diff(before: Snapshot, after: Snapshot): Delta {
  function area(a: Entries, b: Entries): AreaDelta {
    const old = new Map(a), next = new Map(b);
    const remove = [...old.keys()].filter(k => !next.has(k));
    const put = b.filter(([k, v]) => old.get(k) !== v);
    const natural = [...old.keys()].filter(k => next.has(k));
    for (const [k] of put) if (!old.has(k)) natural.push(k);
    const order = [...next.keys()];
    return { put, remove, ...(sameOrder(natural, order) ? {} : { order }) };
  }
  return { local: area(before.local, after.local), session: area(before.session, after.session) };
}
export const hasChanges = (d: Delta) => AREAS.some(a => d[a].put.length > 0 || d[a].remove.length > 0 || d[a].order !== undefined);
export function applyDelta(before: Snapshot, delta: Delta): Snapshot {
  function area(a: Entries, d: AreaDelta): Entries {
    const m = new Map(a);
    for (const k of d.remove) if (!m.delete(k)) throw invalid();
    for (const [k, v] of d.put) m.set(k, v);
    if (d.order === undefined) return entries([...m]);
    if (d.order.length !== m.size || new Set(d.order).size !== m.size || d.order.some(k => !m.has(k))) throw invalid();
    return entries(d.order.map(k => [k, m.get(k)!]));
  }
  return { local: area(before.local, delta.local), session: area(before.session, delta.session) };
}
export function encodeDelta(before: Snapshot, after: Snapshot): WireDelta {
  const delta = diff(before, after), output: WireDelta = { local: delta.local, session: delta.session };
  for (const area of AREAS) {
    const old = new Map(before[area]), put: Entries = [], patches: ValuePatch[] = [];
    for (const [k, value] of delta[area].put) {
      const previous = old.get(k);
      // Avoid overhead for small values and already unrelated/compressed values.
      if (previous === undefined || Math.min(previous.length, value.length) < 16384) { put.push([k, value]); continue; }
      const max = Math.min(previous.length, value.length);
      let prefix = 0, suffix = 0;
      while (prefix < max && previous.charCodeAt(prefix) === value.charCodeAt(prefix)) prefix++;
      while (suffix < max - prefix && previous.charCodeAt(previous.length - 1 - suffix) === value.charCodeAt(value.length - 1 - suffix)) suffix++;
      const replacementLength = value.length - prefix - suffix;
      const patchBytes = 96 + 2 * (k.length + replacementLength);
      // Require at least a 25% and 1 KiB saving. Exact UTF-16 slicing preserves
      // lone surrogates; do not round-trip opaque save strings through UTF-8.
      if (patchBytes <= entryBytes(k, value) * 0.75 && entryBytes(k, value) - patchBytes >= 1024) {
        patches.push({ key: k, oldLength: previous.length, prefix, suffix, value: value.slice(prefix, value.length - suffix) });
      } else put.push([k, value]);
    }
    output[area] = { ...delta[area], put, ...(patches.length ? { patches } : {}) };
  }
  return output;
}
export function decodeDelta(before: Snapshot, input: unknown): Delta {
  const wire = parseWireDelta(input);
  function area(a: Area): AreaDelta {
    const d = wire[a], old = new Map(before[a]), put = d.put.slice();
    let bytes = put.reduce((n, [k, v]) => n + entryBytes(k, v), 0);
    for (const patch of d.patches ?? []) {
      const value = old.get(patch.key);
      if (value === undefined || value.length !== patch.oldLength) throw invalid();
      bytes += 64 + 2 * (patch.key.length + patch.prefix + patch.suffix + patch.value.length);
      if (bytes > LIMIT.area) throw invalid(); // Before constructing any expanded value.
      put.push([patch.key, value.slice(0, patch.prefix) + patch.value + value.slice(value.length - patch.suffix)]);
    }
    return { put, remove: d.remove, ...(d.order === undefined ? {} : { order: d.order }) };
  }
  return { local: area("local"), session: area("session") };
}
export class BoundedArea {
  private readonly values: Map<string, string>;
  private bytes: number;
  constructor(initial: Entries) {
    const checked = entries(initial);
    this.values = new Map(checked);
    this.bytes = checked.reduce((n, [k, v]) => n + entryBytes(k, v), 0);
  }
  get size() { return this.values.size; }
  get(k: string) { return this.values.get(k); }
  has(k: string) { return this.values.has(k); }
  keys() { return [...this.values.keys()]; }
  snapshot(): Entries { return [...this.values]; }
  set(k: string, v: string): number {
    const old = this.values.get(k);
    if (old === v) return 0;
    const n = this.bytes - (old === undefined ? 0 : entryBytes(k, old)) + entryBytes(k, v);
    if (k.length > LIMIT.key || n > LIMIT.area || (old === undefined && this.size >= LIMIT.keys)) throw quota();
    this.values.set(k, v); this.bytes = n;
    return entryBytes(k, v);
  }
  remove(k: string): number {
    const old = this.values.get(k);
    if (old === undefined) return 0;
    this.values.delete(k); this.bytes -= entryBytes(k, old);
    return 64 + 2 * k.length;
  }
  clear(): number {
    if (!this.size) return 0;
    const n = this.bytes; this.values.clear(); this.bytes = 0; return n;
  }
}
export type LoadedPublished = { revision: string | null; snapshot: Snapshot };
export type PublishedCommit = { sourceHash: string; expected: string | null; revision: string; delta: Delta; next: Snapshot };
type Envelope = { v: typeof PROTOCOL_VERSION; epoch: string };
export type ParentPayload = { type: "ack"; seq: number } | { type: "flush" | "drain" | "pause" | "resume" } | { type: "export"; requestId: string };
export type FramePayload = { type: "delta"; seq: number; delta: WireDelta } | { type: "restart"; baseSeq: number; delta: WireDelta }
  | { type: "drained"; reason: "exit"; seq: number } | { type: "exported"; requestId: string; snapshot: Snapshot }
  | { type: "started" } | { type: "error"; message: string };
export type ParentMessage = Envelope & ParentPayload;
export type FrameMessage = Envelope & FramePayload;
export function validToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= LIMIT.token && /^[A-Za-z0-9_-]+$/.test(value);
}
export function envelope<T extends ParentPayload | FramePayload>(epoch: string, payload: T): Envelope & T {
  if (!validToken(epoch)) throw invalid();
  return { ...payload, v: PROTOCOL_VERSION, epoch };
}
function header(value: unknown, epoch: string) {
  const r = record(value);
  if (own(r, "v") !== PROTOCOL_VERSION || own(r, "epoch") !== epoch || !validToken(epoch) || typeof own(r, "type") !== "string") throw invalid();
  return r;
}
export function parseParentMessage(value: unknown, epoch: string): ParentMessage {
  const r = header(value, epoch), type = own(r, "type");
  if (type === "ack") {
    fields(r, ["v", "epoch", "type", "seq"]);
    const seq = integer(own(r, "seq")); if (seq < 1) throw invalid();
    return envelope(epoch, { type, seq });
  }
  if (type === "export") {
    fields(r, ["v", "epoch", "type", "requestId"]);
    const requestId = own(r, "requestId"); if (!validToken(requestId)) throw invalid();
    return envelope(epoch, { type, requestId });
  }
  if (type === "flush" || type === "drain" || type === "pause" || type === "resume") {
    fields(r, ["v", "epoch", "type"]); return envelope(epoch, { type });
  }
  throw invalid();
}
export function parseFrameMessage(value: unknown, epoch: string): FrameMessage {
  const r = header(value, epoch), type = own(r, "type");
  if (type === "delta") {
    fields(r, ["v", "epoch", "type", "seq", "delta"]);
    const seq = integer(own(r, "seq")); if (seq < 1) throw invalid();
    return envelope(epoch, { type, seq, delta: parseWireDelta(own(r, "delta")) });
  }
  if (type === "restart") {
    fields(r, ["v", "epoch", "type", "baseSeq", "delta"]);
    return envelope(epoch, { type, baseSeq: integer(own(r, "baseSeq"), Number.MAX_SAFE_INTEGER - 1), delta: parseWireDelta(own(r, "delta")) });
  }
  if (type === "drained") {
    fields(r, ["v", "epoch", "type", "seq", "reason"]);
    if (own(r, "reason") !== "exit") throw invalid();
    return envelope(epoch, { type, reason: "exit", seq: integer(own(r, "seq")) });
  }
  if (type === "exported") {
    fields(r, ["v", "epoch", "type", "requestId", "snapshot"]);
    const requestId = own(r, "requestId"); if (!validToken(requestId)) throw invalid();
    const snapshot = record(own(r, "snapshot")); fields(snapshot, AREAS);
    return envelope(epoch, { type, requestId, snapshot: parseSnapshot(snapshot) });
  }
  if (type === "error") {
    fields(r, ["v", "epoch", "type", "message"]);
    const message = own(r, "message"); if (typeof message !== "string" || message.length > LIMIT.error) throw invalid();
    return envelope(epoch, { type, message });
  }
  if (type === "started") { fields(r, ["v", "epoch", "type"]); return envelope(epoch, { type }); }
  throw invalid();
}
