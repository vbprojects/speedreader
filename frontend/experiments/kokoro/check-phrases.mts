/** Exhaustive source-ownership probe; run from frontend/ with staged dictionary. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EnglishPhonemizer } from "../../src/audio/phonemizer";
import vocabulary from "../../src/audio/vendor/kokoro-vocabulary.json";

const phonemizer = new EnglishPhonemizer(
  readFileSync("experiments/kokoro/output-browser/en-us.txt", "utf8"), vocabulary,
);
const words = readFileSync("experiments/kokoro/arsenalofdemocracy.md", "utf8")
  .trim().split(/\s+/).map((text, index) => ({ text, index, metadata: [] }));
let windows = 0;
for (let start = 0; start < words.length; start++) {
  for (let length = 1; length <= 24 && start + length <= words.length; length++) {
    const source = words.slice(start, start + length);
    try {
      const phrase = phonemizer.phonemize(source);
      assert.deepEqual(phrase.words.map(word => word.wordIndex), source.map(word => word.index));
      windows++;
    } catch (error) {
      throw new Error(`Source window ${start}:${start + length}: ${source.map(word => word.text).join(" ")}`, { cause: error });
    }
  }
}
console.log(JSON.stringify({ status: "passed", sourceWords: words.length, windows, maximumWindowWords: 24 }));
