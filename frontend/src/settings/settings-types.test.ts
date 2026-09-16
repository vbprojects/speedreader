import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_GLOBAL_SETTINGS, mergeSettings } from "./types";

test("surprisal controls have stable defaults and support per-reader overrides", () => {
  assert.equal(DEFAULT_GLOBAL_SETTINGS.surprisalNGramSize, 3);
  assert.equal(DEFAULT_GLOBAL_SETTINGS.surprisalSensitivity, 0.25);

  const effective = mergeSettings(DEFAULT_GLOBAL_SETTINGS, {
    surprisalNGramSize: 5,
    surprisalSensitivity: 0.6,
  });
  assert.equal(effective.surprisalNGramSize, 5);
  assert.equal(effective.surprisalSensitivity, 0.6);
});

test("audio preferences default off, inherit per book and reject invalid overrides", () => {
  assert.equal(DEFAULT_GLOBAL_SETTINGS.readAloudEnabled, false);
  assert.equal(DEFAULT_GLOBAL_SETTINGS.kokoroPacing, 1);
  const global = { ...DEFAULT_GLOBAL_SETTINGS, kokoroPacing: 1.5, speechCompression: 2 };
  const effective = mergeSettings(global, { readAloudEnabled: true, speechCompression: 3 });
  assert.equal(effective.kokoroPacing, 1.5);
  assert.equal(effective.speechCompression, 3);
  assert.equal(effective.wpm, global.wpm);
  assert.equal(global.readAloudEnabled, false);
  for (const kokoroPacing of [NaN, Infinity, -1, 4.1]) {
    assert.equal(mergeSettings(global, { kokoroPacing }).kokoroPacing, 1.5);
  }
  assert.equal(mergeSettings(global, { readAloudVoice: "" }).readAloudVoice, "piper_lessac");
});

test("Piper voice selection survives settings validation and per-book overrides", () => {
  const piper = mergeSettings(DEFAULT_GLOBAL_SETTINGS, { readAloudVoice: "piper_lessac" });
  assert.equal(piper.readAloudVoice, "piper_lessac");
  assert.equal(mergeSettings(piper, { readAloudVoice: "af_heart" }).readAloudVoice, "af_heart");
  assert.equal(mergeSettings(piper, { readAloudVoice: "unknown-model" }).readAloudVoice, "piper_lessac");
});
