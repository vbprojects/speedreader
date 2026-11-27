import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBytes, readStorageStatus, requestStoragePersistence } from "./storage-status";

test("reading storage estimates never requests persistence, and remaining space is explicitly an estimate", async () => {
  let requests = 0;
  const status = await readStorageStatus({ estimate: async () => ({ usage: 25, quota: 100 }), persisted: async () => false, persist: async () => { requests++; return true; } });
  assert.equal(requests, 0);
  assert.deepEqual(status, { usage: 25, quota: 100, remaining: 75, persistence: "not-granted", estimateAvailable: true, canRequestPersistence: true });
  assert.equal((await readStorageStatus({ estimate: async () => ({ usage: 200, quota: 100 }) })).remaining, 0);
});

test("unsupported, partial and invalid estimates are distinguished without inventing free space", async () => {
  assert.deepEqual(await readStorageStatus({}), { persistence: "unsupported", estimateAvailable: false, canRequestPersistence: false });
  const partial = await readStorageStatus({ estimate: async () => ({ quota: 100 }) });
  assert.equal(partial.quota, 100); assert.equal(partial.remaining, undefined);
  const invalid = await readStorageStatus({ estimate: async () => ({ usage: -1, quota: NaN }) });
  assert.equal(invalid.estimateAvailable, false); assert.equal(invalid.remaining, undefined);
});

test("estimate and protection failures are independent, including synchronous browser exceptions", async () => {
  const estimateDenied = await readStorageStatus({ estimate: () => { throw new Error("denied"); }, persisted: async () => true });
  assert.equal(estimateDenied.persistence, "granted"); assert.match(estimateDenied.problem!, /estimates/);
  const protectionDenied = await readStorageStatus({ estimate: async () => ({ usage: 4, quota: 10 }), persisted: async () => { throw new Error("denied"); } });
  assert.equal(protectionDenied.remaining, 6); assert.equal(protectionDenied.persistence, "unknown"); assert.match(protectionDenied.problem!, /protection/);
});

test("only an explicit persistence action requests permission, with denied and error outcomes retained", async () => {
  let requests = 0;
  const granted = await requestStoragePersistence({ persist: async () => { requests++; return true; }, persisted: async () => false });
  assert.equal(requests, 1); assert.equal(granted.persistence, "granted");
  const denied = await requestStoragePersistence({ persist: async () => false });
  assert.equal(denied.persistence, "not-granted");
  const failed = await requestStoragePersistence({ persist: async () => { throw new Error("denied"); }, persisted: async () => false });
  assert.equal(failed.persistence, "not-granted"); assert.match(failed.problem!, /could not enable/);
  assert.equal((await requestStoragePersistence({})).persistence, "unsupported");
});

test("human readable estimates preserve unavailable rather than showing zero", () => {
  assert.equal(formatBytes(undefined), "Unavailable");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.0 KiB");
  assert.equal(formatBytes(1048576), "1.0 MiB");
});
