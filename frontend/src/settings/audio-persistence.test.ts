import { test } from "node:test";
import assert from "node:assert/strict";
import { SettingsStore } from "./store";

test("legacy settings gain audio defaults and persisted audio preferences round-trip", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let stored = JSON.stringify({ global: { wpm: 450, kokoroPacing: "bad", readAloudEnabled: "true" } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value; },
  } });
  try {
    const store = new SettingsStore();
    assert.equal(store.global.wpm, 450);
    assert.equal(store.global.readAloudVoice, "piper_lessac");
    assert.equal(store.global.kokoroPacing, 1);
    assert.equal(store.global.readAloudEnabled, false);
    store.updateGlobal({ readAloudVoice: "piper_en_US-lessac-high", readAloudEnabled: true, kokoroPacing: 1.5, speechCompression: 3 });
    store.updateGlobal({ kokoroPacing: Infinity });
    const reopened = new SettingsStore();
    assert.equal(reopened.global.readAloudEnabled, true);
    assert.equal(reopened.global.kokoroPacing, 1.5);
    assert.equal(reopened.global.speechCompression, 3);
    assert.equal(reopened.global.wpm, 450);
    assert.equal(reopened.global.readAloudVoice, "piper_en_US-lessac-high");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
