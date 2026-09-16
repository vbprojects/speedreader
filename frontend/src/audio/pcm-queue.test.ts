import { test } from "node:test";
import assert from "node:assert/strict";
import { PcmQueue } from "./pcm-queue";
test("cursor ignores underrun silence and pause preserves sample offset", () => {
  const queue = new PcmQueue(8);
  queue.enqueue(Float32Array.of(1, 2, 3));
  const output = new Float32Array(2);
  queue.setPlaying(true); queue.render(output);
  assert.deepEqual([...output], [1, 2]);
  queue.setPlaying(false); queue.render(output);
  assert.deepEqual([...output], [0, 0]); assert.equal(queue.cursor, 2);
  queue.setPlaying(true); queue.render(output);
  assert.deepEqual([...output], [3, 0]); assert.equal(queue.cursor, 3);
  queue.render(output); assert.equal(queue.cursor, 3);
  queue.enqueue(Float32Array.of(4)); queue.render(output);
  assert.deepEqual([...output], [4, 0]); assert.equal(queue.cursor, 4);
});
test("chunks join without inserted silence; reset discards all old PCM", () => {
  const queue = new PcmQueue(4);
  queue.enqueue(Float32Array.of(1)); queue.enqueue(Float32Array.of(2, 3));
  assert.throws(() => queue.enqueue(Float32Array.of(4, 5)), /budget/);
  queue.setPlaying(true); const output = new Float32Array(3); queue.render(output);
  assert.deepEqual([...output], [1, 2, 3]);
  queue.enqueue(Float32Array.of(9)); queue.reset(100);
  queue.setPlaying(true); queue.render(output);
  assert.deepEqual([...output], [0, 0, 0]); assert.equal(queue.cursor, 100);
});
