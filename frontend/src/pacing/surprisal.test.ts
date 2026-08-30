import assert from "node:assert/strict";
import test from "node:test";
import type { Word } from "../epub/types";
import type { PacingContext } from "./types";
import { characterNGrams, createSurprisalPacingFn } from "./surprisal";
import { availableBackends, selectBackend } from "./select";

const context: PacingContext = {
  profile: { wpm: 600, sentencePauseMs: 0, paragraphPauseMs: 0 },
  stats: { totalWords: 100, avgWordLength: 5 },
  neighbors: {},
};

function word(text: string): Word {
  return { text, index: 0, metadata: [] };
}

test("extracts normalized overlapping boundary trigrams", () => {
  assert.deepEqual(characterNGrams("Quick!"), ["^qu", "qui", "uic", "ick", "ck$"]);
});

test("supports configurable character n-gram widths", () => {
  assert.deepEqual(characterNGrams("read", 2), ["^r", "re", "ea", "ad", "d$"]);
  assert.deepEqual(characterNGrams("read", 4), ["^rea", "read", "ead$"]);
});

test("summed surprisal preserves a word-length effect", () => {
  const shortFn = createSurprisalPacingFn();
  shortFn(word("red"), context);

  const longFn = createSurprisalPacingFn();
  longFn(word("extraordinary"), context);

  assert.ok(longFn.getStats().lastRawSurprisal > shortFn.getStats().lastRawSurprisal);
});

test("repeated trigrams become less surprising", () => {
  const fn = createSurprisalPacingFn({ warmupWords: 0 });
  fn(word("reader"), context);
  const first = fn.getStats().lastRawSurprisal;
  fn(word("reader"), context);
  const second = fn.getStats().lastRawSurprisal;

  assert.ok(second < first, `${second} should be less than ${first}`);
});

test("sensitivity widens duration variation around base WPM", () => {
  const flat = createSurprisalPacingFn({ scoreModel: "normal", sensitivity: 0, warmupWords: 0 });
  const varied = createSurprisalPacingFn({ scoreModel: "normal", sensitivity: 0.5, warmupWords: 0 });
  flat(word("reader"), context);
  varied(word("reader"), context);

  const flatDuration = flat(word("reader"), context);
  const variedDuration = varied(word("reader"), context);

  assert.equal(flatDuration, 100);
  assert.ok(Math.abs(variedDuration - 100) > Math.abs(flatDuration - 100));
});

test("rejects invalid n-gram size and sensitivity", () => {
  assert.throws(() => createSurprisalPacingFn({ n: 0 }), /positive integer/u);
  assert.throws(() => createSurprisalPacingFn({ sensitivity: -0.1 }), /non-negative/u);
});

test("reset clears learned state and diagnostics", () => {
  const fn = createSurprisalPacingFn();
  fn(word("reader"), context);
  assert.ok(fn.getStats().entries > 0);
  fn.reset();
  assert.equal(fn.getStats().position, 0);
  assert.equal(fn.getStats().entries, 0);
});

test("prunes the weakest sparse entries at the configured bound", () => {
  const fn = createSurprisalPacingFn({ n: 1, maxEntries: 2 });
  fn(word("a"), context);
  fn(word("b"), context);
  fn(word("c"), context);

  assert.ok(fn.getStats().entries <= 2);
  assert.ok(fn.getStats().prunedEntries > 0);
});

test("Exponential-Gamma calibration updates its conjugate posterior", () => {
  const fn = createSurprisalPacingFn({
    scoreModel: "exponential-gamma",
    scoreAlpha0: 2,
    scoreBeta0: 20,
    warmupWords: 0,
  });
  fn(word("reader"), context);
  const stats = fn.getStats();

  assert.equal(stats.scoreModel, "exponential-gamma");
  assert.ok(stats.scoreAlpha > 2);
  assert.ok(stats.scoreBeta > 20);
  assert.ok(stats.expectedScore > 0);
  assert.equal(stats.lastRelativeDifficulty, stats.lastRawSurprisal / stats.expectedScore - 1);
});

test("registers all surprisal calibrations as selectable app backends", () => {
  assert.ok(availableBackends().includes("surprisal-normal"));
  assert.ok(availableBackends().includes("surprisal-exponential-gamma"));
  assert.ok(availableBackends().includes("surprisal-lognormal-nig"));
  assert.equal(selectBackend("surprisal-normal").name, "surprisal-normal");
  assert.equal(selectBackend("surprisal-exponential-gamma").name, "surprisal-exponential-gamma");
  assert.equal(selectBackend("surprisal-lognormal-nig").name, "surprisal-lognormal-nig");
});

test("Lognormal-NIG calibration updates independent discounted length bands", () => {
  const fn = createSurprisalPacingFn({
    scoreModel: "lognormal-nig",
    scoreHalfLifeWords: 10,
    warmupWords: 0,
  });

  fn(word("red"), context);
  const short = fn.getStats();
  assert.equal(short.scoreBucket, "short");
  assert.equal(short.scoreModel, "lognormal-nig");
  assert.ok(Number.isFinite(short.lastRelativeDifficulty));
  assert.ok(short.expectedScore > 0);

  fn(word("extraordinary"), context);
  const long = fn.getStats();
  assert.equal(long.scoreBucket, "long");
  assert.equal(long.scoreBucketEvidence, 0);

  fn(word("uncharacteristically"), context);
  const repeatedLong = fn.getStats();
  assert.equal(repeatedLong.scoreBucket, "long");
  assert.ok(repeatedLong.scoreBucketEvidence > 0);
  assert.ok(repeatedLong.scoreAlpha > 3);
});
