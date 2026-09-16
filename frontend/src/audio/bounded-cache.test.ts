import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedCache, nativeCacheKey, processedCacheKey } from "./bounded-cache";
import { preparationPolicy } from "./preparation-policy";
test("LRU obeys both count and byte budgets", () => {
  const cache = new BoundedCache<number>(10, 2);
  cache.put("a", 1, 4); cache.put("b", 2, 4); cache.get("a");
  cache.put("c", 3, 5);
  assert.equal(cache.get("b"), undefined); assert.equal(cache.bytes, 9);
  cache.put("d", 4, 10);
  assert.equal(cache.size, 1); assert.equal(cache.bytes, 10);
  assert.equal(cache.put("large", 5, 11), false); assert.equal(cache.size, 1);
  cache.clear(); assert.equal(cache.bytes, 0);
});
test("compression changes processed identity independently of native synthesis", () => {
  const input = { model: "model1", runtime: "ort1", voice: "heart", pacing: 1, phonemeIds: [0, 4, 0] };
  const native = nativeCacheKey(input);
  assert.notEqual(processedCacheKey(native, "dsp1", 1, 48000), processedCacheKey(native, "dsp1", 2, 48000));
  assert.notEqual(native, nativeCacheKey({ ...input, pacing: 2 }));
  assert.notEqual(native, nativeCacheKey({ ...input, voice: "bella" }));
});
test("prepared and lookahead policy stop at count, bytes and time limits", () => {
  const single = preparationPolicy("prepared-chunk");
  assert.equal(single.shouldPrepare(0, 0, 0), true);
  assert.equal(single.shouldPrepare(1, 1, 1), false);
  const ahead = preparationPolicy("lookahead", { maxChunks: 3, maxBytes: 100, targetSeconds: 10 });
  assert.equal(ahead.shouldPrepare(2, 50, 9), true);
  assert.equal(ahead.shouldPrepare(3, 50, 9), false);
  assert.equal(ahead.shouldPrepare(2, 100, 9), false);
  assert.equal(ahead.shouldPrepare(2, 50, 10), false);
});
