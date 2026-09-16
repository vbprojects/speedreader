import { test } from "node:test";
import assert from "node:assert/strict";
import { exposeNativeDurations, exposePiperDurations } from "./duration-export";
test("graph output append preserves unrelated protobuf fields and graph content", () => {
  // model.ir_version=8, graph={name:'g'}, producer_name='x'
  const input = Uint8Array.of(8, 8, 58, 3, 18, 1, 103, 18, 1, 120);
  const result = new Uint8Array(exposeNativeDurations(input.buffer));
  assert.deepEqual([...result.subarray(0, 3)], [8, 8, 58]);
  assert.deepEqual([...result.subarray(4, 7)], [18, 1, 103]);
  assert.equal(result[7], 98); // GraphProto.output, length-delimited
  assert.deepEqual([...result.subarray(-3)], [18, 1, 120]);
  assert.ok(new TextDecoder().decode(result).includes('/encoder/Gather_output_0'));
  assert.equal(input.length, 10);
});
test("malformed or missing graph is rejected", () => {
  for (const bytes of [[58, 9, 1], [8, 8], [255], [15]]) {
    assert.throws(() => exposeNativeDurations(Uint8Array.from(bytes).buffer));
  }
});

test("Piper output append preserves graph contents and exposes its own duration tensor", () => {
  const input = Uint8Array.of(8, 8, 58, 3, 18, 1, 103, 18, 1, 120);
  const patched = new Uint8Array(exposePiperDurations(input.buffer));
  assert.deepEqual([...patched.subarray(4, 7)], [18, 1, 103]);
  assert.deepEqual([...patched.subarray(-3)], [18, 1, 120]);
  assert.ok(new TextDecoder().decode(patched).includes("/Ceil_output_0"));
  assert.ok(!new TextDecoder().decode(patched).includes("/encoder/Gather"));
});
