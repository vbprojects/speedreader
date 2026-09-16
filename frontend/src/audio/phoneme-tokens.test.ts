import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePhonemes } from "./phoneme-tokens";
import vocabulary from "./vendor/kokoro-vocabulary.json";
test("grouped stress and vowel retain both supported phonemes", () => {
  const result = encodePhonemes(['ˈɪ', 'z'], vocabulary);
  assert.deepEqual(result.ids, [0, vocabulary['ˈ'], vocabulary['ɪ'], vocabulary.z, 0]);
  assert.deepEqual(result.offsets, [1, 3, 4]);
});
test("unknown phonemes skip without shifting later word ownership", () => {
  const result = encodePhonemes(['☃', 'ˈ☃ɪ', '☃'], vocabulary);
  assert.deepEqual(result.ids, [0, vocabulary['ˈ'], vocabulary['ɪ'], 0]);
  assert.deepEqual(result.offsets, [1, 1, 3, 3]);
});
