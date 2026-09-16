import { test } from "node:test";
import assert from "node:assert/strict";
import { ObservedSpeechRate } from "./observed-rate";
test("observed rate counts consumed speech only and resets independently of transport", () => {
  const rate = new ObservedSpeechRate();
  assert.equal(rate.add(24000, 2, 24000), null);
  assert.equal(rate.add(24000, 2, 24000), 120);
  assert.equal(rate.add(0, 0, 24000), 120); // paused or underrun
  rate.reset(); assert.equal(rate.value, null);
  assert.equal(rate.add(48000, 6, 48000), 360);
});
