import { test } from "node:test";
import assert from "node:assert/strict";
import { compressAudio } from "./dsp";
const rate = 24000;
const tone = Float32Array.from({ length: rate * 2 }, (_, i) => .5 * Math.sin(2 * Math.PI * 440 * i / rate));
test("identity preserves waveform and word boundaries exactly", () => {
  const words = [{ wordIndex: 4, startSample: 100, endSample: 24000 }];
  const result = compressAudio(tone, rate, 1, words);
  assert.deepEqual(result.pcm, tone); assert.deepEqual(result.words, words);
});
test("tempo changes duration while retaining tone pitch and bounded word mapping", () => {
  for (const speed of [.5, 1.5, 2, 4]) {
    const result = compressAudio(tone, rate, speed, [{ wordIndex: 0, startSample: 0, endSample: tone.length }]);
    assert.ok(Math.abs(result.pcm.length - tone.length / speed) < rate * .05);
    let crossings = 0;
    const start = Math.floor(result.pcm.length * .2), end = Math.floor(result.pcm.length * .8);
    for (let i = start + 1; i < end; i++) if (result.pcm[i - 1] < 0 && result.pcm[i] >= 0) crossings++;
    const pitch = crossings * rate / (end - start);
    assert.ok(Math.abs(pitch - 440) < 8, `pitch ${pitch} at ${speed}`);
    assert.equal(result.words[0].startSample, 0);
    assert.equal(result.words[0].endSample, result.pcm.length);
  }
});
test("mapped synthetic speech-like burst onsets stay within 80 ms through tempo processing", () => {
  const starts = [.3, .9, 1.5];
  const pcm = new Float32Array(rate * 2);
  for (const start of starts) for (let i = Math.round(start * rate); i < (start + .2) * rate; i++) {
    pcm[i] = .6 * Math.sin(2 * Math.PI * 220 * i / rate);
  }
  const words = starts.map((start, wordIndex) => ({ wordIndex, startSample: Math.round(start * rate), endSample: Math.round((start + .2) * rate) }));
  for (const compression of [.5, 1.5, 2, 4]) {
    const result = compressAudio(pcm, rate, compression, words);
    const onsets: number[] = [];
    let lastActive = -Infinity;
    for (let i = 0; i < result.pcm.length; i++) if (Math.abs(result.pcm[i]) > .1) {
      if (i - lastActive > rate * .03) onsets.push(i);
      lastActive = i;
    }
    for (const word of result.words) {
      assert.ok(onsets.some(onset => Math.abs(onset - word.startSample) < rate * .08),
        `No signal onset within 80 ms of word ${word.wordIndex} at ${compression}`);
    }
  }
});
test("short and uneven chunks flush complete source/output mappings", () => {
  for (const length of [1, 120, 600, 1000, 2400, 10000, 10731, 34992, 113534]) {
    const pcm = Float32Array.from({ length }, (_, i) => .4 * Math.sin(i * .051));
    for (const compression of [.5, 1.5, 2, 4]) {
      const result = compressAudio(pcm, rate, compression, [{ wordIndex: 0, startSample: 0, endSample: length }]);
      assert.ok(result.pcm.length > 0);
      assert.equal(result.words[0].endSample, result.pcm.length);
    }
  }
});
