import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateWpm } from "./estimate";
import { KOKORO_WPM_PROFILE as profile } from "./profiles";
import { DEFAULT_AUDIO_SETTINGS } from "./settings";

const context = { modelRevision: profile.modelRevision, language: "en" };
const estimate = (p: number, c = 1) => estimateWpm({ ...DEFAULT_AUDIO_SETTINGS, readAloudVoice: "af_heart", kokoroPacing: p, speechCompression: c }, context, profile);

test("rational estimate remains bounded and increasing; compression multiplies it", () => {
  let previous = 0;
  for (let step = 5; step <= 40; step++) {
    const result = estimate(step / 10);
    const compressed = estimate(step / 10, 4);
    assert.notEqual(result.status, "unavailable");
    assert.notEqual(compressed.status, "unavailable");
    if (result.status === "unavailable" || compressed.status === "unavailable") return;
    assert.ok(result.wpm > previous && result.wpm < profile.maximum);
    assert.equal(compressed.wpm, 4 * result.wpm);
    assert.equal(result.roundedWpm % 5, 0);
    previous = result.wpm;
  }
});

test("matches the experiment and labels provenance and extrapolation", () => {
  const measured = estimate(1.6442109092788029);
  assert.notEqual(measured.status, "unavailable");
  if (measured.status === "unavailable") return;
  assert.ok(Math.abs(measured.wpm - 290.1811178348926) < 1e-6); // empirical curve, not observed WPM
  assert.equal(measured.status, "experimental");
  assert.equal(measured.extrapolated, false);
  const outside = estimate(.5, 4);
  assert.ok(outside.status !== "unavailable" && outside.extrapolated);
  assert.equal(estimateWpm(DEFAULT_AUDIO_SETTINGS, { ...context, modelRevision: "other" }, profile).status, "unavailable");
  assert.equal(estimateWpm({ ...DEFAULT_AUDIO_SETTINGS, readAloudVoice: "bf_emma" }, context, profile).status, "unavailable");
  for (const value of [NaN, Infinity, 0, 5]) assert.equal(estimate(value).status, "unavailable");
});
