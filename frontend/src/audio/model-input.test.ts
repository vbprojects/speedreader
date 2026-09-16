import { test } from "node:test";
import assert from "node:assert/strict";
import { selectVoiceStyle } from "./model-input";
test("voice style table handles the full model context without truncating text", () => {
  const voice = Float32Array.from({ length: 510 * 256 }, (_, i) => Math.floor(i / 256));
  assert.equal(selectVoiceStyle(voice, 134)[0], 132);
  assert.equal(selectVoiceStyle(voice, 511)[0], 509);
  assert.equal(selectVoiceStyle(voice, 512)[0], 509);
  assert.throws(() => selectVoiceStyle(voice, 513), /token limit/);
  assert.throws(() => selectVoiceStyle(new Float32Array(256), 5), /style table/);
});
