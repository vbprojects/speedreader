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
