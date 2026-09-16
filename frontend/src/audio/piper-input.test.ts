import { test } from "node:test";
import assert from "node:assert/strict";
import { piperInput, type PiperConfig } from "./piper-input";
import type { PhonemizedPhrase } from "./phonemizer";
import vocabulary from "./vendor/kokoro-vocabulary.json";
const config: PiperConfig = { audio: { sample_rate: 16000 },
  inference: { length_scale: 1, noise_scale: .667, noise_w: .8 },
  phoneme_id_map: { '^': [1], '_': [0], '$': [2], e: [14], 'ɪ': [74], ' ': [3], t: [31], 'ʃ': [96] } };
const phrase: PhonemizedPhrase = { text: 'A ch', phonemes: 'A ʧ', ids: [0, vocabulary.A, vocabulary[' '], vocabulary['ʧ'], 0],
  words: [{ wordIndex: 5, tokenStart: 1, tokenEnd: 3 }, { wordIndex: 6, tokenStart: 3, tokenEnd: 4 }], normalization: [] };
test('Piper expands compact IPA and remaps original words across inserted padding', () => {
  const result = piperInput(phrase, config);
  assert.deepEqual(result.ids, [1, 0, 14, 0, 74, 0, 3, 0, 31, 0, 96, 0, 2]);
  assert.deepEqual(result.words, [{ wordIndex: 5, tokenStart: 2, tokenEnd: 8 }, { wordIndex: 6, tokenStart: 8, tokenEnd: 12 }]);
  assert.equal(result.text, phrase.text);
  assert.equal(result.phonemes, 'eɪ tʃ');
  assert.deepEqual(phrase.words[0], { wordIndex: 5, tokenStart: 1, tokenEnd: 3 });
});
test('Piper skips unmapped speech sounds and retains an empty word span', () => {
  const result = piperInput({ ...phrase, ids: [0, vocabulary.z, 0],
    words: [{ wordIndex: 5, tokenStart: 1, tokenEnd: 2 }] }, config);
  assert.deepEqual(result.ids, [1, 0, 2]);
  assert.deepEqual(result.words, [{ wordIndex: 5, tokenStart: 2, tokenEnd: 2 }]);
  assert.equal(result.phonemes, '');
  assert.throws(() => piperInput(phrase, { ...config, phoneme_id_map: {} }), /cannot speak phoneme/);
});

test('voice-specific unsupported quotes retain zero-duration source spans', () => {
  const quoted: PhonemizedPhrase = { ...phrase, text: '" A "',
    ids: [0, vocabulary['"'], vocabulary.A, vocabulary['"'], 0],
    words: [{ wordIndex: 5, tokenStart: 1, tokenEnd: 2 },
      { wordIndex: 6, tokenStart: 2, tokenEnd: 3 }, { wordIndex: 7, tokenStart: 3, tokenEnd: 4 }] };
  for (const mapping of [config.phoneme_id_map, { ...config.phoneme_id_map, '"': [] }]) {
    const result = piperInput(quoted, { ...config, phoneme_id_map: mapping });
    assert.equal(result.text, quoted.text);
    assert.equal(result.phonemes, 'eɪ');
    assert.deepEqual(result.words, [
      { wordIndex: 5, tokenStart: 2, tokenEnd: 2 },
      { wordIndex: 6, tokenStart: 2, tokenEnd: 6 },
      { wordIndex: 7, tokenStart: 6, tokenEnd: 6 },
    ]);
  }
  const supported = piperInput(quoted, { ...config, phoneme_id_map: { ...config.phoneme_id_map, '"': [150] } });
  assert.equal(supported.phonemes, '"eɪ"');
  assert.ok(supported.ids.includes(150));
});
