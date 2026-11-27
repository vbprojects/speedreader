import { AREAS, LIMIT, entryBytes, parseSnapshot, type Area, type Entries, type Snapshot } from "../ingestion/sugarcube/storage-protocol";

// Recovery can inspect saves larger than the runtime quota without making the
// normal runtime unbounded. Files beyond this limit stay untouched on disk.
export const RECOVERY_LIMIT = Object.freeze({ fileBytes: 64 * 1024 * 1024, logicalBytes: 64 * 1024 * 1024, entriesPerArea: 8192, keyUnits: 65536 });
export const SAVE_FILE_KIND = "speedreader-published-save";
const SOURCE_HASH = /^[a-f0-9]{64}$/;

export interface RecoveryCandidate {
  sourceHash: string;
  snapshot: Snapshot;
  logicalBytes: Record<Area, number>;
  entryCount: Record<Area, number>;
  fitsRuntime: boolean;
  violations: string[];
}
export type RecoverySelection = Record<Area, ReadonlySet<number>>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The save must contain an object.");
  return value as Record<string, unknown>;
}

/** Validate before projecting or rendering any imported strings. Never truncate. */
export function inspectRecoverySnapshot(value: unknown, sourceHash: string): RecoveryCandidate {
  if (!SOURCE_HASH.test(sourceHash)) throw new Error("The story source hash is invalid.");
  const input = record(value);
  const logicalBytes = { local: 0, session: 0 }, entryCount = { local: 0, session: 0 };
  const violations: string[] = [];
  const snapshot: Snapshot = { local: [], session: [] };
  let total = 0;
  for (const area of AREAS) {
    const list = input[area];
    if (!Array.isArray(list) || list.length > RECOVERY_LIMIT.entriesPerArea) throw new Error(`The ${area} save exceeds the recovery entry limit or is malformed. Original data is unchanged.`);
    const seen = new Set<string>();
    for (let index = 0; index < list.length; index++) {
      const item: unknown = list[index];
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || typeof item[1] !== "string") throw new Error(`The ${area} save contains an invalid entry. Original data is unchanged.`);
      const [key, val] = item as [string, string];
      if (key.length > RECOVERY_LIMIT.keyUnits || seen.has(key)) throw new Error(`The ${area} save contains a duplicate or excessive key. Original data is unchanged.`);
      seen.add(key);
      const bytes = entryBytes(key, val);
      total += bytes; logicalBytes[area] += bytes;
      if (total > RECOVERY_LIMIT.logicalBytes) throw new Error("The save exceeds the recovery size limit. Use a desktop recovery tool; the original is unchanged.");
      snapshot[area].push([key, val]);
    }
    entryCount[area] = snapshot[area].length;
    if (list.length > LIMIT.keys) violations.push(`${area}: more than ${LIMIT.keys} keys`);
    if (logicalBytes[area] > LIMIT.area) violations.push(`${area}: over the ${LIMIT.area / 1024 ** 2} MiB limit`);
    if (snapshot[area].some(([key]) => key.length > LIMIT.key)) violations.push(`${area}: key longer than ${LIMIT.key} characters`);
  }
  return { sourceHash, snapshot, logicalBytes, entryCount, fitsRuntime: violations.length === 0, violations };
}

export function readRecoveryDocument(value: unknown, sourceHash: string): RecoveryCandidate {
  const input = record(value);
  if (input.sourceHash !== sourceHash) throw new Error("This save belongs to a different story or source revision.");
  if (input.version !== 1) throw new Error("This save format version is unsupported.");
  if (input.kind === SAVE_FILE_KIND) return inspectRecoverySnapshot(input.snapshot, sourceHash);
  if (input.kind !== undefined || !("local" in input) || !("session" in input)) throw new Error("Select a Speedreader published save or its original version 1 export.");
  return inspectRecoverySnapshot(input, sourceHash);
}

export async function readRecoveryFile(file: Pick<File, "size" | "text">, sourceHash: string): Promise<RecoveryCandidate> {
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > RECOVERY_LIMIT.fileBytes) throw new Error("Select a nonempty JSON save no larger than 64 MiB. The file has not been read.");
  const text = await file.text();
  if (text.length > RECOVERY_LIMIT.fileBytes) throw new Error("This save exceeds the recovery text limit.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("The selected file is not valid save JSON."); }
  return readRecoveryDocument(value, sourceHash);
}

export function allRecoveryEntries(candidate: RecoveryCandidate): RecoverySelection {
  return { local: new Set(candidate.snapshot.local.map((_, i) => i)), session: new Set(candidate.snapshot.session.map((_, i) => i)) };
}

/** Selection is explicit; whole opaque values are never edited or truncated. */
export function selectedRecovery(candidate: RecoveryCandidate, selection: RecoverySelection): RecoveryCandidate {
  const snapshot: Snapshot = { local: [], session: [] };
  for (const area of AREAS) {
    for (const i of selection[area]) {
      if (!Number.isSafeInteger(i) || i < 0 || i >= candidate.snapshot[area].length) throw new Error("Invalid recovery selection.");
    }
    snapshot[area] = candidate.snapshot[area].filter((_, i) => selection[area].has(i));
  }
  return inspectRecoverySnapshot(snapshot, candidate.sourceHash);
}

export function snapshotForReplacement(candidate: RecoveryCandidate): Snapshot {
  if (!candidate.fitsRuntime) throw new Error("The selection still exceeds this story's storage limits. Choose entries to remove or keep an export for later recovery.");
  return parseSnapshot(candidate.snapshot);
}

// Escaping bounded chunks avoids a second single giant JSON string. Splitting a
// surrogate pair may escape both units separately, which parses identically.
export function recoveryBlob(candidate: RecoveryCandidate): Blob {
  const safe = inspectRecoverySnapshot(candidate.snapshot, candidate.sourceHash);
  const parts: BlobPart[] = []; let bytes = 0;
  const encoder = new TextEncoder();
  const append = (text: string) => {
    bytes += encoder.encode(text).byteLength;
    if (bytes > RECOVERY_LIMIT.fileBytes) throw new Error("This exported JSON exceeds 64 MiB. Export smaller selections or use desktop recovery.");
    parts.push(text);
  };
  const string = (value: string) => {
    append('"');
    for (let i = 0; i < value.length; i += 32768) append(JSON.stringify(value.slice(i, i + 32768)).slice(1, -1));
    append('"');
  };
  const entries = (list: Entries) => {
    append("[");
    list.forEach(([key, value], i) => { if (i) append(","); append("["); string(key); append(","); string(value); append("]"); });
    append("]");
  };
  append(`{"kind":"${SAVE_FILE_KIND}","version":1,"sourceHash":"${safe.sourceHash}","snapshot":{"local":`);
  entries(safe.snapshot.local); append(',"session":'); entries(safe.snapshot.session); append("}}");
  return new Blob(parts, { type: "application/json" });
}

/** Called by a user action, never by a background conflict handler. */
export function downloadRecovery(candidate: RecoveryCandidate, label: "saved" | "session" | "selection") {
  const url = URL.createObjectURL(recoveryBlob(candidate));
  const a = document.createElement("a");
  a.href = url; a.download = `speedreader-${candidate.sourceHash}-${label}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}
