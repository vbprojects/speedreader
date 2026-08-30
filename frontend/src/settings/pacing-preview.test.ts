import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_GLOBAL_SETTINGS } from "./types";
import { buildHistogram, buildPacingPreview, buildPreviewOrder } from "./pacing-preview";

test("histogram accounts for every timing and includes its maximum", () => {
  const bins = buildHistogram([100, 100, 150, 200], 3);
  assert.equal(bins.reduce((sum, bin) => sum + bin.count, 0), 4);
  assert.equal(bins[0].startMs, 100);
  assert.equal(bins[bins.length - 1].endMs, 200);
  assert.equal(bins[bins.length - 1].count, 1);
});

test("preview is deterministic and does not share adaptive engine state", () => {
  const settings = {
    ...DEFAULT_GLOBAL_SETTINGS,
    pacingModel: "surprisal-normal" as const,
    surprisalSensitivity: 0.6,
  };
  assert.deepEqual(buildPacingPreview(settings), buildPacingPreview(settings));
});

test("surprisal variation widens the preview timing distribution", () => {
  const flat = buildPacingPreview({
    ...DEFAULT_GLOBAL_SETTINGS,
    pacingModel: "surprisal-normal",
    sentencePauseMs: 0,
    paragraphPauseMs: 0,
    surprisalSensitivity: 0,
  });
  const expressive = buildPacingPreview({
    ...DEFAULT_GLOBAL_SETTINGS,
    pacingModel: "surprisal-normal",
    sentencePauseMs: 0,
    paragraphPauseMs: 0,
    surprisalSensitivity: 1,
  });

  assert.equal(flat.maxMs - flat.minMs, 0);
  assert.ok(expressive.maxMs - expressive.minMs > 0);
});

test("pulse order is a stable permutation of sample indexes", () => {
  const first = buildPreviewOrder(24);
  const second = buildPreviewOrder(24);
  assert.deepEqual(first, second);
  assert.deepEqual([...first].sort((a, b) => a - b), Array.from({ length: 24 }, (_, index) => index));
  assert.notDeepEqual(first, Array.from({ length: 24 }, (_, index) => index));
});
