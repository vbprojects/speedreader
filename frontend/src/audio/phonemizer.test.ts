import { test } from "node:test";
import assert from "node:assert/strict";
import { EnglishPhonemizer, phonemizeChunk } from "./phonemizer";
import vocab from "./vendor/kokoro-vocabulary.json";
const dictionary = Array.from({ length: 1000 }, (_, i) => `TEST${i}\ttˈɛst`).join("\n") +
  "\nDOCTOR\tdˈɑktəɹ\nDOLLARS\tdˈɑləɹz\nDR\tdɹˈIv";
const phonemizer = new EnglishPhonemizer(dictionary, vocab);
const words = (text: string) => text.split(" ").map((text, index) => ({ text, index, metadata: [] }));
test("normalization expands currency and titles without losing original word positions", () => {
  const phrase = phonemizer.phonemize(words("Dr. Smith paid $25."));
  assert.equal(phrase.text, "Dr. Smith paid $25.");
  assert.ok(phrase.phonemes.includes("dˈɑktəɹ"));
  assert.ok(phrase.phonemes.includes("dˈɑləɹz"));
  assert.deepEqual(phrase.words.map(w => w.wordIndex), [0, 1, 2, 3]);
  assert.equal(phrase.words[0].tokenStart, 1);
  assert.equal(phrase.words[3].tokenEnd, phrase.ids.length - 1);
});
test("punctuation, contractions, Unicode quotes and hyphens retain source ownership", () => {
  const source = words("I don't think they're overpriced. The well-known reader said, “Let’s read again!”");
  const phrase = phonemizer.phonemize(source);
  assert.equal(phrase.words.length, source.length);
  assert.deepEqual(phrase.words.map(w => w.wordIndex), source.map(w => w.index));
  for (let i = 1; i < phrase.words.length; i++) assert.equal(phrase.words[i].tokenStart, phrase.words[i - 1].tokenEnd);
});
test("model limit splits at source words without truncation, loss or duplication", () => {
  const source = words("This is a test of speech. ".repeat(20).trim());
  let remaining = source;
  const indices: number[] = [];
  while (remaining.length) {
    const chunk = phonemizeChunk(phonemizer, remaining, 64);
    assert.ok(chunk.ids.length <= 64);
    indices.push(...chunk.words.map(w => w.wordIndex));
    remaining = remaining.slice(chunk.words.length);
  }
  assert.deepEqual(indices, source.map(w => w.index));
});
test("unsupported text keeps source ownership with empty token spans", () => {
  for (const text of ["hello 你好", "hello 😀", "😀 hello 👨‍👩‍👧‍👦 world 🇺🇸", "😀 你好"] ) {
    const source = words(text), phrase = phonemizer.phonemize(source);
    assert.equal(phrase.text, text);
    assert.deepEqual(phrase.words.map(w => w.wordIndex), source.map(w => w.index));
    source.forEach((word, i) => {
      if (!/[a-z]/i.test(word.text)) assert.equal(phrase.words[i].tokenStart, phrase.words[i].tokenEnd);
    });
  }
});
test("social text expands within original word ownership", () => {
  const source = words("Hello😀world @alice #books 1/2");
  const phrase = phonemizer.phonemize(source);
  assert.equal(phrase.text, "Hello😀world @alice #books 1/2");
  assert.equal(phrase.words.length, 4);
  assert.ok(phrase.normalization[0].spokenText.toLowerCase().includes("hello"));
  assert.ok(phrase.normalization[3].spokenText.toLowerCase().includes("slash"));
});
test("custom normalization profiles expand source words without changing offsets", () => {
  const custom = new EnglishPhonemizer(dictionary, vocab, { id: "test", rules: [
    { id: "acronym", replace: text => text.replace("TTS", "text to speech") },
  ] });
  const result = custom.phonemize(words("TTS works"));
  assert.equal(result.text, "TTS works");
  assert.equal(result.words.length, 2);
  assert.equal(result.normalization[0].originalEnd, 3);
  assert.match(result.normalization[0].spokenText, /text to speech/i);
});

test("final single-letter words retain separate source ownership", () => {
  for (const text of ["This is a", "you and I", "a", "a b c"]) {
    const source = words(text);
    const phrase = phonemizer.phonemize(source);
    assert.deepEqual(phrase.words.map(word => word.wordIndex), source.map(word => word.index));
  }
});
