/**
 * Reproducible synthetic profile; does not run imported story code. The one
 * vendor routine evaluated is lz-string 1.5.0 extracted from the pinned fixture.
 * Usage (from frontend):
 * node --import tsx experiments/sugarcube-runtime-spike/storage-profile.mts \
 *   experiments/sugarcube-runtime-spike/fixture-current.html ../benchmarks/storage-profile.json
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import vm from "node:vm";
import { gzipSync, gunzipSync } from "node:zlib";
import * as p from "../../src/ingestion/sugarcube/storage-protocol";

const fixturePath = resolve(process.argv[2] ?? "experiments/sugarcube-runtime-spike/fixture-current.html");
const outputPath = resolve(process.argv[3] ?? "../benchmarks/storage-profile.json");
const fixture = await readFile(fixturePath, "utf8");
const start = fixture.indexOf("var LZString="), end = fixture.indexOf(';"function"==typeof define', start);
if (start < 0 || end < 0) throw new Error("Cannot locate the pinned fixture's LZString implementation");
const lzSource = fixture.slice(start, end + 1);
const lz = vm.runInNewContext(lzSource + "; LZString", Object.create(null), { timeout: 1000 }) as {
  compressToUTF16(value: string): string;
  decompressFromUTF16(value: string): string;
};
if (!fixture.includes('return LZString.compressToUTF16(Serial.stringify(obj))')) throw new Error("Fixture serialization changed; update this profile");

function hash(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function entropy(seed: number, bytes: number) {
  const out = Buffer.allocUnsafe(bytes); let state = seed;
  for (let i = 0; i < bytes; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    out[i] = state & 255;
  }
  return out.toString("base64");
}
const assets = entropy(0x12345678, 620000);
const history = Array.from({ length: 2500 }, (_, i) => ({ title: `Passage ${i}`, variables: { turn: i, hp: 100, path: ["forest", "lake", "village"], inventory: ["lamp", "key"] } }));
function state(turn: number, count: number, payload: string) {
  return JSON.stringify({ index: turn, delta: history.slice(0, count), variables: { payload, score: 99, name: "reader" } });
}
const raw = state(7, 2000, assets), changedEarly = state(8, 2000, assets);
const appended = state(7, 2001, assets);
const rawAppend = JSON.stringify({ variables: { payload: assets }, history: history.slice(0, 2000) });
const rawAppended = JSON.stringify({ variables: { payload: assets }, history: history.slice(0, 2001) });
const lzRaw = lz.compressToUTF16(raw), lzEarly = lz.compressToUTF16(changedEarly);
const lzAppendBefore = lz.compressToUTF16(rawAppend), lzAppendAfter = lz.compressToUTF16(rawAppended);
assert.equal(lz.decompressFromUTF16(lzRaw), raw);
const cases = [
  { name: "raw-json-small-early-edit", description: "Synthetic JSON save; one digit changed before stable history and large opaque variable", before: raw, after: changedEarly },
  { name: "raw-json-history-insertion", description: "Synthetic JSON save; passage history grows before an unchanged opaque variable", before: raw, after: appended },
  { name: "fixture-lz-utf16-early-edit", description: "Same JSON-only synthetic states compressed with the fixture's lz-string 1.5.0 WebStorage codec", before: lzRaw, after: lzEarly },
  { name: "fixture-lz-utf16-history-append", description: "Fixture codec with history at end of object, then one extra passage appended", before: lzAppendBefore, after: lzAppendAfter },
  { name: "base64-complete-replacement", description: "Uncorrelated deterministic high-entropy binary payloads encoded as Base64", before: entropy(0x31415926, 750000), after: entropy(0x27182818, 750000) },
  { name: "base64-small-middle-edit", description: "A local edit within a large Base64-like opaque string (best-case correlation)", before: assets, after: assets.slice(0, 400000) + "CHANGED!" + assets.slice(400008) },
];

const iterations = 25, warmups = 3;
function measure(fn: () => unknown) {
  for (let i = 0; i < warmups; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) { const start = performance.now(); fn(); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b);
  return { p50: samples[Math.floor(samples.length / 2)], p95: samples[Math.ceil(samples.length * 0.95) - 1] };
}
function wireBytes(delta: p.WireDelta) {
  let total = 0;
  for (const area of p.AREAS) {
    for (const [key, value] of delta[area].put) total += p.entryBytes(key, value);
    for (const key of delta[area].remove) total += 64 + 2 * key.length;
    for (const key of delta[area].order ?? []) total += 64 + 2 * key.length;
    for (const patch of delta[area].patches ?? []) total += 32 + p.entryBytes(patch.key, patch.value);
  }
  return total;
}
const results = cases.map(item => {
  const before: p.Snapshot = { local: [["sugarcube.save", item.before]], session: [] };
  const after: p.Snapshot = { local: [["sugarcube.save", item.after]], session: [] };
  p.parseSnapshot(before); p.parseSnapshot(after);
  const full = p.diff(before, after), wire = p.encodeDelta(before, after);
  const exact = Buffer.from(item.after, "utf16le"), gz = gzipSync(exact, { level: 6 });
  assert.deepEqual(p.applyDelta(before, p.decodeDelta(before, wire)), after);
  assert.deepEqual(gunzipSync(gz), exact);
  const frame = p.envelope("profile-epoch-0000000001", { type: "delta", seq: 1, delta: wire });
  p.parseFrameMessage(frame, frame.epoch);
  return {
    name: item.name, description: item.description,
    beforeCodeUnits: item.before.length, afterCodeUnits: item.after.length,
    afterUTF16Sha256: hash(exact), fullLogicalBytes: wireBytes(full), patchedLogicalBytes: wireBytes(wire),
    wireFraction: wireBytes(wire) / wireBytes(full), selectedPatch: Boolean(wire.local.patches?.length),
    gzipExactUTF16Bytes: gz.length, gzipFractionOfFullUTF16: gz.length / exact.length,
    timingsMs: {
      encodePatch: measure(() => p.encodeDelta(before, after)),
      validateDecodeApply: measure(() => p.applyDelta(before, p.decodeDelta(before, wire))),
      cloneFullDelta: measure(() => structuredClone(full)),
      cloneWireDelta: measure(() => structuredClone(wire)),
      gzipLevel6: measure(() => gzipSync(exact, { level: 6 })),
      gunzip: measure(() => gunzipSync(gz)),
    },
  };
});
const report = {
  schema: 1, generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  targetCommit: "8d26a2bceeb173ab924382de544af611824838cb", fixtureSha256: hash(fixture), vendorRoutineSha256: hash(lzSource),
  iterations, warmups,
  method: "Synthetic JSON-only save objects; fixture lz-string 1.5.0 for two cases; deterministic xorshift32 Base64 payloads. Logical bytes use 64-byte entry + UTF-16 accounting, not physical disk/clone measurements. Gzip of exact UTF-16LE bytes is an experiment only. Node single-process timing is not an iOS/mobile benchmark.",
  decision: "Ship bounded prefix/suffix patches only when saving at least 25% and 1 KiB on a value of at least 16,384 code units. Preserve full-value fallback for unrelated or insufficiently correlated saves. Do not ship gzip or a general binary-diff engine: they add CPU, working memory and decoder attack surface; collect representative device traces first. Database rows remain full opaque values; patches only reduce transport cloning.",
  results,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
const percent = (n: number) => `${(n * 100).toFixed(2)}%`;
const rows = results.map(r => `| ${r.name} | ${r.fullLogicalBytes.toLocaleString("en-US")} | ${r.patchedLogicalBytes.toLocaleString("en-US")} | ${percent(1 - r.wireFraction)} | ${r.timingsMs.encodePatch.p50.toFixed(3)} | ${r.timingsMs.gzipLevel6.p50.toFixed(3)} | ${percent(r.gzipFractionOfFullUTF16)} |`).join("\n");
const markdown = `# SugarCube storage transport profile\n\nGenerated ${report.generatedAt} on ${report.node} (${report.platform}/${report.arch}); ${iterations} measured iterations after ${warmups} warmups. These are container measurements, not mobile device results.\n\n${report.method}\n\n| Synthetic workload | Full logical bytes | Selected wire bytes | Wire reduction | Patch encode median ms | Gzip median ms | Gzip / full UTF-16 bytes |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n## Decision\n\n${report.decision}\n\nThe compressed early-edit case deliberately changes a field before the large stable payload; prefix/suffix correlation may disappear even though the uncompressed state changed only slightly. The compressed append case probes the opposite extreme. Their contrast is why selection is per changed value, never a claim that all SugarCube saves benefit. Unchanged keys are omitted entirely in both designs.\n\nExact UTF-16 round trips (including separate regression coverage for lone surrogates) and area caps apply before reconstruction. There is no unbounded patch chain: the parent decodes against the one matching sequence/revision snapshot and persists the complete value atomically. No gzip decoder or binary compression dependency enters the runtime.\n\n## Reproduce\n\nFrom the patched repository frontend directory:\n\n\`\`\`sh\nnode --import tsx experiments/sugarcube-runtime-spike/storage-profile.mts experiments/sugarcube-runtime-spike/fixture-current.html ../benchmarks/storage-profile.json\n\`\`\`\n\nThe JSON contains SHA-256 digests, p50/p95 encode, decode, clone, gzip and gunzip timings, and exact input sizes. The fixture is pinned by commit and hash; the script evaluates only its isolated vendor LZString routine. Memory/disk reductions beyond the bounded wire payload are not measured. Real iOS profiling should record main-thread stalls, energy use, peak memory and process kills with representative user-consented saves before enabling additional codecs.\n\nSources inspected: the repository fixture at frontend/experiments/sugarcube-runtime-spike/fixture-current.html, at the commit and SHA-256 listed in JSON; [WHATWG Storage interface](https://html.spec.whatwg.org/multipage/webstorage.html#storage).\n`;
await writeFile(outputPath.replace(/\.json$/, "") + ".md", markdown);
console.log(JSON.stringify({ outputPath, cases: results.length, iterations, fixtureSha256: report.fixtureSha256 }));
