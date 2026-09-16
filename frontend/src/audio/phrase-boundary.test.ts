import { test } from "node:test";
import assert from "node:assert/strict";
import { phraseWordCount } from "./phrase-boundary";
const words = (text: string) => text.split(" ").map((text, index) => ({ text, index, metadata: [] }));

test("groups short sentences rather than synthesizing each sentence separately", () => {
  const source = words("This is the first short sentence. This is the second short sentence. An unfinished tail");
  assert.equal(phraseWordCount(source), 12);
  assert.equal(source[5].text, "sentence.");
  assert.equal(source[11].text, "sentence.");
});
test("respects the word budget and uses the last complete sentence within it", () => {
  const source = words("This is the first short sentence. This is the second short sentence. An unfinished tail");
  assert.equal(phraseWordCount(source, 10), 6);
  assert.equal(phraseWordCount(words("one two three")), 3);
  assert.equal(phraseWordCount(Array.from({ length: 30 }, (_, index) => ({ text: "word", index, metadata: [] }))), 24);
});
