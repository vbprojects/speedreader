import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWaitingUpdate, deferAppUpdate, protectReaderSession } from "./pwa-update";

test("service-worker activation waits for every reader lease", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let shared = 0, updates = 0;
  const locks = { async request(_name: string, options: { mode: string }, callback: (lock: unknown) => Promise<void>) {
    if (options.mode === "shared") {
      shared++;
      try { await callback({}); } finally { shared--; }
    } else await callback(shared ? null : {});
  } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks } });
  try {
    const first = protectReaderSession(), second = protectReaderSession();
    deferAppUpdate(async () => { updates++; });
    await applyWaitingUpdate(); assert.equal(updates, 0);
    first(); await Promise.resolve(); await applyWaitingUpdate(); assert.equal(updates, 0);
    second(); await new Promise(resolve => setTimeout(resolve, 0)); await applyWaitingUpdate(); assert.equal(updates, 1);
    await applyWaitingUpdate(); assert.equal(updates, 1);
    let attempts = 0;
    const warn = console.warn;
    console.warn = () => {};
    try {
      deferAppUpdate(async () => { if (++attempts === 1) throw new Error("temporary update failure"); });
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(attempts, 1);
      await applyWaitingUpdate(); assert.equal(attempts, 2);
      await applyWaitingUpdate(); assert.equal(attempts, 2);
    } finally { console.warn = warn; }
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
