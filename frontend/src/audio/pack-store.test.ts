import { test } from "node:test";
import assert from "node:assert/strict";
import { PackStore, assetDigest, type VoicePack } from "./pack-store";
async function setup() {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const hash = await assetDigest(bytes);
  const files = new Map<string, ArrayBuffer>();
  const packs = new Map<string, VoicePack>();
  let downloads = 0;
  const store = new PackStore({
    async read(key) { return files.get(key); },
    async write(key, data) { files.set(key, data); },
    async remove(key) { files.delete(key); },
  }, {
    async list() { return [...packs.values()]; },
    async put(pack) { packs.set(pack.id, pack); },
    async remove(id) { packs.delete(id); },
  }, async () => { downloads++; return bytes; });
  const pack: VoicePack = { id: "heart", version: "1", runtimeRevision: "1", assets: [
    { sha256: hash, bytes: 3, url: "https://example.test/model", role: "model", license: "Apache-2.0" },
  ] };
  return { store, pack, files, packs, downloads: () => downloads };
}
test("interrupted probe preserves verified bytes without committing", async () => {
  const s = await setup();
  await assert.rejects(s.store.install(s.pack, async () => { throw new Error("Inference failed"); }));
  assert.equal(s.packs.size, 0);
  assert.equal(s.files.size, 1);
  await s.store.install(s.pack, async resolve => { await resolve(s.pack.assets[0]); });
  assert.equal(s.downloads(), 1);
  assert.equal(s.packs.size, 1);
});
test("failed replacement preserves prior installed version", async () => {
  const s = await setup();
  await s.store.install(s.pack, async () => {});
  await assert.rejects(s.store.install({ ...s.pack, version: "2" }, async () => { throw new Error("Bad runtime"); }));
  assert.equal(s.packs.get(s.pack.id)?.version, "1");
});
test("eviction and corruption require repair despite installed metadata", async () => {
  const s = await setup();
  await s.store.install(s.pack, async () => {});
  s.files.clear();
  await assert.rejects(s.store.verify(s.pack), /repair/);
  s.files.set(s.pack.assets[0].sha256, new Uint8Array([3, 2, 1]).buffer);
  await assert.rejects(s.store.verify(s.pack), /repair/);
  await s.store.install(s.pack, async () => {});
  await s.store.verify(s.pack);
  assert.equal(s.downloads(), 2);
});
test("shared assets survive until the last voice is removed", async () => {
  const s = await setup();
  await s.store.install(s.pack, async () => {});
  await s.store.install({ ...s.pack, id: "other" }, async () => {});
  await s.store.remove(s.pack.id);
  assert.equal(s.files.size, 1);
  await s.store.remove("other");
  assert.equal(s.files.size, 0);
});
test("integrity failure and cancellation never commit", async () => {
  const s = await setup();
  await assert.rejects(s.store.install({ ...s.pack, assets: [{ ...s.pack.assets[0], sha256: "0".repeat(64) }] }, async () => {}), /Integrity/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(s.store.install(s.pack, async () => {}, abort.signal));
  assert.equal(s.packs.size, 0);
});
test("discarding incomplete installation removes its unreferenced bytes", async () => {
  const s = await setup();
  await assert.rejects(s.store.install(s.pack, async () => { throw new Error("Cancelled probe"); }));
  assert.equal(s.files.size, 1);
  await s.store.remove(s.pack.id, s.pack);
  assert.equal(s.files.size, 0);
});
test("quota failure retains the prior installed version", async () => {
  const s = await setup();
  await s.store.install(s.pack, async () => {});
  const fail = new PackStore({ async read() { return undefined; }, async write() { throw new DOMException("Full", "QuotaExceededError"); }, async remove() {} }, {
    async list() { return [...s.packs.values()]; }, async put(pack) { s.packs.set(pack.id, pack); }, async remove(id) { s.packs.delete(id); },
  }, async () => new Uint8Array([1, 2, 3]).buffer);
  await assert.rejects(fail.install({ ...s.pack, version: "2" }, async () => {}), { name: "QuotaExceededError" });
  assert.equal(s.packs.get(s.pack.id)?.version, "1");
});
test("successful upgrades retain old assets and removal later cleans both versions", async () => {
  const s = await setup();
  await s.store.install(s.pack, async () => {});
  const bytes = new Uint8Array([4, 5, 6]).buffer;
  const next = { ...s.pack, version: "2", assets: [{ ...s.pack.assets[0], sha256: await assetDigest(bytes) }] };
  const store = new PackStore({ async read(hash) { return s.files.get(hash); }, async write(hash, bytes) { s.files.set(hash, bytes); },
    async remove(hash) { s.files.delete(hash); } }, {
    async list() { return [...s.packs.values()]; }, async put(pack) { s.packs.set(pack.id, pack); }, async remove(id) { s.packs.delete(id); },
  }, async () => bytes);
  await store.install(next, async () => {});
  assert.equal(s.files.size, 2);
  assert.equal(s.packs.get(next.id)?.retiredAssets?.[0].sha256, s.pack.assets[0].sha256);
  await store.remove(next.id);
  assert.equal(s.files.size, 0);
});
