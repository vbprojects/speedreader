#!/usr/bin/env node
/** Desktop-only, explicit recovery of an already exported save. This cannot
 * read a mobile browser's IndexedDB: export the original JSON or extract it
 * from a browser profile on the source device before using this command. */
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AREAS, LIMIT, entryBytes, parseSnapshot, type Area, type Entries, type Snapshot } from "../../src/ingestion/sugarcube/storage-protocol.ts";

const SAVE_FILE_KIND = "speedreader-published-save";
const DEFAULT_MAX_MIB = 128, HARD_MAX_MIB = 512;
const HASH = /^[a-f0-9]{64}$/;
const HELP = `Desktop published-save recovery

Run from frontend with Node 22.14+ and the project's dependencies installed:
  node --import tsx experiments/published-storage-resilience/recover-save.mts \\
    --input original.json --source-hash <64 lowercase hex characters> --list
  node --import tsx experiments/published-storage-resilience/recover-save.mts \\
    --input original.json --source-hash <hash> --output selected.json \\
    --keep local:0 --keep local:12 --keep session:2

Options:
  --input PATH           Existing legacy v1 or portable published-save JSON.
  --source-hash HASH     Expected story source SHA-256; must match the export.
  --list                 Print JSON lines of keys, indices and sizes; no values.
  --output PATH          Create a new portable JSON file; never overwrite a file.
  --keep AREA:INDEX      Explicitly select a whole entry; repeat as necessary.
  --empty               Explicitly produce an empty save instead of --keep.
  --max-input-mib N      Preflight/read limit, default ${DEFAULT_MAX_MIB}, maximum ${HARD_MAX_MIB} MiB.
  --help                Show this help without reading or writing files.

Indices are zero-based and selection preserves the original per-area ordering.
Whole values and keys are preserved exactly. Entries are never truncated; an
invalid or over-quota selection fails before output creation. Selected results
must fit ${LIMIT.keys} keys and ${LIMIT.area / 1024 ** 2} MiB of logical data per area.
Omitted entries remain in the original input; keep that file as your backup.

This tool cannot access a mobile browser's IndexedDB. First export the original
JSON on the source device or extract the full v1/portable snapshot from a saved
browser profile. A v2 manifest alone has no values and cannot be recovered by
this tool. Import the output through Speedreader's recovery screen and confirm
the replacement there; this command never changes any browser save.

The desktop limit is separate from the mobile recovery limit. Large JSON files
require additional parsing memory; raise the limit only on a suitable desktop.
The original file is never modified. A disk-write failure may leave a partial
new output file; the command reports failure and never overwrites it on retry.
`;

type Options = { input: string; sourceHash: string; maxBytes: number; list: boolean; output?: string; keep: Record<Area, Set<number>>; empty: boolean };
function parseArguments(args: string[]): Options | undefined {
  if (args.length === 1 && args[0] === "--help") return;
  const result: Options = { input: "", sourceHash: "", maxBytes: DEFAULT_MAX_MIB * 1024 ** 2, list: false, keep: { local: new Set(), session: new Set() }, empty: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (!["--input", "--source-hash", "--max-input-mib", "--list", "--output", "--keep", "--empty"].includes(option)) throw new Error("Unknown option. Use --help for usage.");
    if (option !== "--keep" && seen.has(option)) throw new Error(`Repeated option: ${option}.`);
    seen.add(option);
    if (option === "--list") { result.list = true; continue; }
    if (option === "--empty") { result.empty = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}.`);
    if (option === "--input") result.input = value;
    if (option === "--source-hash") result.sourceHash = value;
    if (option === "--output") result.output = value;
    if (option === "--max-input-mib") {
      const size = Number(value);
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(size) || size > HARD_MAX_MIB) throw new Error(`--max-input-mib must be an integer from 1 to ${HARD_MAX_MIB}.`);
      result.maxBytes = size * 1024 ** 2;
    }
    if (option === "--keep") {
      const match = /^(local|session):(0|[1-9]\d*)$/.exec(value), entry = Number(match?.[2]);
      if (!match || !Number.isSafeInteger(entry)) throw new Error("Use --keep local:INDEX or --keep session:INDEX with a nonnegative integer.");
      const selected = result.keep[match[1] as Area];
      if (selected.has(entry)) throw new Error(`Repeated selection: ${value}.`);
      selected.add(entry);
    }
  }
  if (!result.input || !HASH.test(result.sourceHash)) throw new Error("Supply --input and the expected 64-character lowercase --source-hash.");
  const count = result.keep.local.size + result.keep.session.size;
  if (result.list) {
    if (result.output || count || result.empty) throw new Error("--list cannot be combined with --output, --keep or --empty.");
  } else if (!result.output || (result.empty ? count !== 0 : count === 0)) {
    throw new Error("To create a save, supply --output and explicit --keep selections, or --empty alone.");
  }
  if (result.output && resolve(result.output) === resolve(result.input)) throw new Error("The output must be a new file distinct from the original input.");
  return result;
}

/** Check the open file before reading, then cap every read even if it grows. */
async function readDocument(path: string, limit: number): Promise<unknown> {
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0) throw new Error("The input must be a nonempty regular JSON file.");
    if (before.size > limit) throw new Error(`Input exceeds the ${limit / 1024 ** 2} MiB preflight limit. The file has not been read.`);
    const decoder = new TextDecoder("utf-8", { fatal: true }), chunks: string[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024); let total = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, limit + 1 - total), null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw new Error("Input grew beyond the preflight limit while reading. No output was created.");
      try { chunks.push(decoder.decode(buffer.subarray(0, bytesRead), { stream: true })); }
      catch { throw new Error("The input is not valid UTF-8 JSON. No bytes were replaced."); }
    }
    try { chunks.push(decoder.decode()); } catch { throw new Error("The input ends with invalid UTF-8. No bytes were replaced."); }
    const after = await file.stat();
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("The input changed while it was read. Retry from a stable copy.");
    try { return JSON.parse(chunks.join("")) as unknown; }
    catch { throw new Error("The input is not valid save JSON."); }
  } finally { await file.close(); }
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function inspectDocument(value: unknown, sourceHash: string) {
  if (!record(value) || value.sourceHash !== sourceHash) throw new Error("The export belongs to a different story/source revision, or has no source hash.");
  if (value.version !== 1) throw new Error("Use a legacy v1 or portable save export. A v2 manifest alone does not contain save values.");
  const raw = value.kind === SAVE_FILE_KIND ? value.snapshot : value.kind === undefined ? value : undefined;
  if (!record(raw)) throw new Error("Unsupported save document; expected a v1 or portable snapshot.");
  const snapshot: Snapshot = { local: [], session: [] }, bytes = { local: 0, session: 0 };
  for (const area of AREAS) {
    const entries = raw[area];
    if (!Array.isArray(entries)) throw new Error(`The ${area} area must be an array of string pairs.`);
    const seen = new Set<string>();
    for (let index = 0; index < entries.length; index++) {
      const pair: unknown = entries[index];
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") throw new Error(`Invalid string pair at ${area}:${index}. No entries were discarded.`);
      if (seen.has(pair[0])) throw new Error(`Duplicate key at ${area}:${index}. No entries were discarded.`);
      seen.add(pair[0]); bytes[area] += entryBytes(pair[0], pair[1]);
    }
    // The validated input remains the complete original; avoid copying tuples.
    snapshot[area] = entries as Entries;
  }
  return { snapshot, bytes };
}
async function emit(value: unknown) {
  await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(value) + "\n", cause => cause ? reject(cause) : resolve()));
}

export async function recoverSave(args: string[]): Promise<void> {
  const options = parseArguments(args);
  if (!options) { await new Promise<void>((resolve, reject) => process.stdout.write(HELP, cause => cause ? reject(cause) : resolve())); return; }
  const { snapshot, bytes } = inspectDocument(await readDocument(options.input, options.maxBytes), options.sourceHash);
  if (options.list) {
    await emit({ sourceHash: options.sourceHash, entryCount: { local: snapshot.local.length, session: snapshot.session.length }, logicalBytes: bytes });
    for (const area of AREAS) {
      for (let index = 0; index < snapshot[area].length; index++) {
        const [key, value] = snapshot[area][index];
        await emit({ entry: `${area}:${index}`, key, keyUnits: key.length, valueUnits: value.length, logicalBytes: entryBytes(key, value) });
      }
    }
    return;
  }
  const selected: Snapshot = { local: [], session: [] };
  for (const area of AREAS) {
    for (const index of options.keep[area]) if (index >= snapshot[area].length) throw new Error(`Selection ${area}:${index} does not exist. No output was created.`);
    selected[area] = snapshot[area].filter((_, index) => options.keep[area].has(index));
  }
  let valid: Snapshot;
  try { valid = parseSnapshot(selected); }
  catch { throw new Error("The selected entries do not fit the runtime key/count/5 MiB area limits. Select fewer whole entries; no output was created."); }
  const text = JSON.stringify({ kind: SAVE_FILE_KIND, version: 1, sourceHash: options.sourceHash, snapshot: valid }) + "\n";
  const output = await open(options.output!, "wx", 0o600);
  try { await output.writeFile(text, "utf8"); await output.sync(); }
  finally { await output.close(); }
  await emit({ output: options.output, sourceHash: options.sourceHash, entryCount: { local: valid.local.length, session: valid.session.length }, logicalBytes: Object.fromEntries(AREAS.map(area => [area, valid[area].reduce((total, [key, value]) => total + entryBytes(key, value), 0)])) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void recoverSave(process.argv.slice(2)).catch(cause => {
    process.stderr.write(`Recovery failed: ${cause instanceof Error ? cause.message : "Unknown error."}\n`);
    process.exitCode = 1;
  });
}
