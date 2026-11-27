import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseSnapshot, type Snapshot } from "../ingestion/sugarcube/storage-protocol";

const run = promisify(execFile), sourceHash = "a".repeat(64);
const script = fileURLToPath(new URL("../../experiments/published-storage-resilience/recover-save.mts", import.meta.url));
const portable = (snapshot: Snapshot) => ({ kind: "speedreader-published-save", version: 1, sourceHash, snapshot });
async function fixture(t: TestContext, value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "speedreader-recover-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "original.json"), output = join(directory, "selected.json");
  await writeFile(input, JSON.stringify(value));
  const before = await readFile(input);
  const cli = (...args: string[]) => run(process.execPath, ["--import", "tsx", script, "--input", input, "--source-hash", sourceHash, ...args], { maxBuffer: 8 * 1024 * 1024 });
  return { directory, input, output, before, cli };
}
const failed = (pattern: RegExp) => (cause: unknown) => {
  assert.ok(cause && typeof cause === "object" && "stderr" in cause);
  assert.match(String(cause.stderr), pattern); return true;
};

test("desktop CLI lists more than 8192 entries as escaped keys and sizes without exposing opaque values", async t => {
  const snapshot: Snapshot = { local: Array.from({ length: 8193 }, (_, i) => [`key-${i}`, i ? "v" : "SECRET_OPAQUE_VALUE"]), session: [["line\n\u001b[31m", "SESSION_SECRET"]] };
  const { cli, input, before } = await fixture(t, { version: 1, sourceHash, ...snapshot });
  const { stdout } = await cli("--list");
  assert.equal(stdout.includes("SECRET_OPAQUE_VALUE"), false); assert.equal(stdout.includes("SESSION_SECRET"), false);
  const lines = stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(lines[0].entryCount, { local: 8193, session: 1 });
  assert.equal(lines.length, 8195); assert.equal(lines[8193].entry, "local:8192");
  assert.equal(lines[8194].key, "line\n\u001b[31m");
  assert.deepEqual(await readFile(input), before);
});

test("desktop CLI selects exact whole v1 entries, retains ordering and preserves UTF-16 surrogates", async t => {
  const snapshot: Snapshot = { local: [["__proto__", "\ud800\u0000\udfff😀"], ["skip", "original-only"], ["last", "last-save"]], session: [["__proto__", "independent"]] };
  const { cli, output, input, before } = await fixture(t, { version: 1, sourceHash, updatedAt: 123, ...snapshot });
  const { stdout } = await cli("--output", output, "--keep", "local:2", "--keep", "session:0", "--keep", "local:0");
  assert.equal(stdout.includes("last-save"), false);
  const exported = JSON.parse(await readFile(output, "utf8"));
  assert.equal(exported.kind, "speedreader-published-save"); assert.equal(exported.sourceHash, sourceHash); assert.equal(exported.version, 1);
  assert.deepEqual(parseSnapshot(exported.snapshot), { local: [snapshot.local[0], snapshot.local[2]], session: snapshot.session });
  assert.deepEqual(await readFile(input), before);
});

test("portable inputs work and creating an empty save requires an explicit choice", async t => {
  const { cli, output, input, before } = await fixture(t, portable({ local: [["slot", "save"]], session: [] }));
  await assert.rejects(cli("--output", output), failed(/explicit --keep/));
  await assert.rejects(stat(output), { code: "ENOENT" });
  await cli("--output", output, "--empty");
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")).snapshot, { local: [], session: [] });
  assert.deepEqual(await readFile(input), before);
});

test("CLI verifies source identity and rejects malformed, duplicate or invalid selections before output", async t => {
  const { cli, output } = await fixture(t, portable({ local: [["slot", "save"]], session: [] }));
  await assert.rejects(cli("--output", output, "--keep", "local:1"), failed(/does not exist/));
  await assert.rejects(cli("--output", output, "--keep", "local:0", "--keep", "local:0"), failed(/Repeated selection/));
  await assert.rejects(cli("--output", output, "--keep", "local:0", "--empty"), failed(/explicit --keep/));
  await assert.rejects(stat(output), { code: "ENOENT" });
  const mismatched = await fixture(t, { ...portable({ local: [], session: [] }), sourceHash: "b".repeat(64) });
  await assert.rejects(mismatched.cli("--list"), failed(/different story/));
  for (const value of [
    { version: 1, sourceHash, local: [["ok", "save"], ["bad", 42]], session: [] },
    { version: 1, sourceHash, local: [["same", "A"], ["same", "B"]], session: [] },
    { version: 2, sourceHash, order: { local: ["save"], session: [] } },
  ]) {
    const invalid = await fixture(t, value);
    await assert.rejects(invalid.cli("--output", invalid.output, "--keep", "local:0"), failed(/Invalid string pair|Duplicate key|v2 manifest alone/));
    await assert.rejects(stat(invalid.output), { code: "ENOENT" });
  }
});

test("oversized selections fail atomically and remain unmodified in the input", async t => {
  const original: Snapshot = { local: [["large", "x".repeat(3 * 1024 * 1024)], ["small", "keep"]], session: [] };
  const { cli, output, input, before } = await fixture(t, portable(original));
  await assert.rejects(cli("--output", output, "--keep", "local:0"), failed(/do not fit the runtime/));
  await assert.rejects(stat(output), { code: "ENOENT" });
  await cli("--output", output, "--keep", "local:1");
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")).snapshot.local, [original.local[1]]);
  assert.deepEqual(await readFile(input), before);
});

test("wx output creation never overwrites an existing file or the original input", async t => {
  const { cli, output, input, before } = await fixture(t, portable({ local: [["slot", "save"]], session: [] }));
  await writeFile(output, "KEEP_EXISTING_OUTPUT");
  await assert.rejects(cli("--output", output, "--keep", "local:0"), failed(/EEXIST/));
  assert.equal(await readFile(output, "utf8"), "KEEP_EXISTING_OUTPUT");
  await assert.rejects(cli("--output", input, "--keep", "local:0"), failed(/distinct from the original/));
  assert.deepEqual(await readFile(input), before);
});

test("input preflight rejects size before parsing and caps the configurable limit at 512 MiB", async t => {
  const { cli, input, output } = await fixture(t, {});
  await writeFile(input, "NOT JSON"); await truncate(input, 1024 * 1024 + 1);
  await assert.rejects(cli("--list", "--max-input-mib", "1"), failed(/preflight limit.*has not been read/));
  await assert.rejects(cli("--list", "--max-input-mib", "513"), failed(/integer from 1 to 512/));
  assert.equal((await stat(input)).size, 1024 * 1024 + 1);
  await assert.rejects(stat(output), { code: "ENOENT" });
});

test("invalid UTF-8 is rejected rather than replacing original bytes", async t => {
  const { cli, input, output } = await fixture(t, {});
  const invalid = Buffer.concat([Buffer.from(`{"version":1,"sourceHash":"${sourceHash}","local":[["k","`), Buffer.from([0xc3, 0x28]), Buffer.from('"]],"session":[]}')]);
  await writeFile(input, invalid);
  await assert.rejects(cli("--output", output, "--keep", "local:0"), failed(/not valid UTF-8 JSON/));
  assert.deepEqual(await readFile(input), invalid); await assert.rejects(stat(output), { code: "ENOENT" });
});
