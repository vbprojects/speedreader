import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSpeechText, DEFAULT_SPEECH_TEXT_PROFILE } from "./speech-text";
const word = (text: string) => ({ text, index: 12, metadata: [] });
test("fallback separates unsupported characters and removes emoji sequences and scripts", () => {
  assert.equal(normalizeSpeechText(word("hello😀world")), "hello world");
  for (const text of ["👨‍👩‍👧‍👦", "🇺🇸", "你好", "❤️", "👍🏽", "..."]) assert.equal(normalizeSpeechText(word(text)), "");
  assert.equal(normalizeSpeechText(word("@alice")), "alice");
  assert.equal(normalizeSpeechText(word("#books")), "books");
  assert.equal(normalizeSpeechText(word("1/2")), "1 slash 2");
});
test("profiles compose ordered rules and cannot mutate source or bypass fallback", () => {
  const source = Object.freeze(word("TTS"));
  const profile = { id: "specific", rules: [...DEFAULT_SPEECH_TEXT_PROFILE.rules,
    { id: "expand", replace: (text: string) => text.replace("TTS", "text 😀 to speech") }] };
  assert.equal(normalizeSpeechText(source, profile), "text to speech");
  assert.equal(source.text, "TTS");
  assert.equal(normalizeSpeechText(source, { id: "skip", rules: [{ id: "skip", replace: () => "" }] }), "");
  assert.throws(() => normalizeSpeechText(source, { id: "broken", rules: [{ id: "broken", replace: () => { throw Error("broken rule"); } }] }), /broken rule/);
});
