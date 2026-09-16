import { test } from "node:test";
import assert from "node:assert/strict";
import { OutputWatchdog } from "./output-watchdog";
test("device clock stalls are errors, while pauses and preparation reset the watchdog", () => {
  const monitor = new OutputWatchdog();
  assert.equal(monitor.check(1, 0, true), false);
  assert.equal(monitor.check(1, 4999, true), false);
  assert.equal(monitor.check(1, 5000, true), true);
  assert.equal(monitor.check(1, 10000, false), false);
  assert.equal(monitor.check(2, 15000, true), false);
  assert.equal(monitor.check(3, 20000, true), false);
  assert.equal(monitor.check(3, 21000, false), false);
  assert.equal(monitor.check(3, 22000, true), false);
});
