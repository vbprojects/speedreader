import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { decodeKittenStyle, kittenInput, loadKittenStyle, selectKittenStyle } from "./kitten-input";
import { EnglishPhonemizer } from "./phonemizer";
import vocabulary from "./vendor/kokoro-vocabulary.json";
import kittenVocabulary from "./vendor/kitten-vocabulary.json";
import { alignWordSamples } from "./alignment";

const dictionary = Array.from({ length: 1000 }, (_, i) => `TEST${i}\ttˈɛst`).join("\n") +
  "\nHELLO\thəlˈO\nWORLD\twˈɜɹld\nREADER\tɹˈidəɹ";
const phonemizer = new EnglishPhonemizer(dictionary, vocabulary);
const words = (text: string) => text.split(" ").map((text, index) => ({ text, index, metadata: [] }));
const ids = (text: string) => Array.from(text, symbol => (kittenVocabulary as Record<string, number>)[symbol]);

test("Kitten uses its own IPA vocabulary and upstream punctuation-separated tokenization", () => {
  const phrase = kittenInput(phonemizer.phonemize(words("Hello world.")));
  assert.deepEqual(phrase.ids, [0, ...ids("həlˈoʊ wˈɜɹld ."), 10, 0]);
  assert.deepEqual(phrase.words.map(word => word.wordIndex), [0, 1]);
  const samples = alignWordSamples(words("Hello world."), phrase.words, phrase.ids.map(() => 1),
    { samplesPerFrame: 600, sampleOffset: 0, waveformSamples: phrase.ids.length * 600 });
  assert.ok(samples[0].endSample <= samples[1].startSample);
  assert.ok(samples[1].endSample <= phrase.ids.length * 600);
});

test("Kitten preserves original-word ownership through expansions and unspoken words", () => {
  for (const text of ["Dr. reader paid $25.", "😀 hello 你好 world 😀", "😀 你好", "“Hello” world!", "well-known 1/2 reader"]) {
    const source = words(text), english = phonemizer.phonemize(source), phrase = kittenInput(english);
    assert.deepEqual(phrase.words.map(word => word.wordIndex), source.map(word => word.index));
    phrase.words.forEach((word, i) => {
      assert.ok(word.tokenStart <= word.tokenEnd);
      if (i) assert.ok(word.tokenStart >= phrase.words[i - 1].tokenEnd);
      if (english.words[i].tokenStart === english.words[i].tokenEnd) assert.equal(word.tokenStart, word.tokenEnd);
    });
    assert.ok(phrase.ids.every(id => Object.values(kittenVocabulary).includes(id)));
  }
});

function npy(rows = 3): Uint8Array {
  const header = new TextEncoder().encode(`{'descr': '<f4', 'fortran_order': False, 'shape': (${rows}, 256), }\n`);
  const bytes = new Uint8Array(10 + header.length + rows * 256 * 4);
  bytes.set([0x93, ...new TextEncoder().encode("NUMPY"), 1, 0]);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, header.length, true); bytes.set(header, 10);
  for (let i = 0; i < rows * 256; i++) view.setFloat32(10 + header.length + i * 4, i, true);
  return bytes;
}
test("NPZ style loading selects the requested speaker and text-length row with clamping", async () => {
  const zip = new JSZip(); zip.file("expr-voice-2-f.npy", npy());
  const buffer = await zip.generateAsync({ type: "arraybuffer" });
  const style = new Float32Array(await loadKittenStyle(buffer, "expr-voice-2-f"));
  assert.equal(selectKittenStyle(style, 1)[0], 256);
  assert.equal(selectKittenStyle(style, 400)[0], 512);
  await assert.rejects(loadKittenStyle(buffer, "missing"), /missing/);
  assert.throws(() => selectKittenStyle(style, 0), /Invalid/);
  assert.throws(() => decodeKittenStyle(npy().subarray(0, 40)), /geometry/);
  const invalid = npy(); new DataView(invalid.buffer).setFloat32(invalid.length - 4, NaN, true);
  assert.throws(() => decodeKittenStyle(invalid), /values/);
});
