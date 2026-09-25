import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKEND_STORAGE_KEY, loadSpeechBackend, saveSpeechBackend } from "./backend-preference";

test("backend choice survives new readers and reloads and CPU can replace WebGPU", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(loadSpeechBackend(storage), "wasm");
  saveSpeechBackend("webgpu", storage);
  assert.equal(loadSpeechBackend(storage), "webgpu");
  saveSpeechBackend("wasm", storage);
  assert.equal(loadSpeechBackend(storage), "wasm");
  values.set(BACKEND_STORAGE_KEY, "auto");
  assert.equal(loadSpeechBackend(storage), "wasm");
});
test("unavailable backend storage has a safe default and reports write failures", () => {
  assert.equal(loadSpeechBackend({ getItem() { throw Error("denied"); } }), "wasm");
  assert.throws(() => saveSpeechBackend("webgpu", { setItem() { throw Error("quota"); } }), /quota/);
});
