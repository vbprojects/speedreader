import { deepStrictEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { SelfCorrectingClock } from "./clock";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for clock state");
    await wait(2);
  }
}

test("clock blocks at boundary zero until the interaction is resolved", async () => {
  let allowed = false;
  const blocked: number[] = [];
  const ticks: number[] = [];
  const clock = new SelfCorrectingClock({
    durations: [1, 1],
    canStart: () => allowed,
    onTick: (index) => ticks.push(index),
    onBlocked: (boundary) => blocked.push(boundary),
  });
  clock.start(0);
  equal(clock.running, false);
  deepStrictEqual(blocked, [0]);
  allowed = true;
  clock.resume();
  await waitFor(() => ticks.length === 1);
  deepStrictEqual(ticks, [1]);
  clock.destroy();
});

test("clock pauses at the next boundary without replaying the current word", async () => {
  let allowNext = false;
  const blocked: number[] = [];
  const ticks: number[] = [];
  const clock = new SelfCorrectingClock({
    durations: [2, 2],
    onTick: (index) => ticks.push(index),
    canAdvance: (_from, next) => next !== 1 || allowNext,
    onBlocked: (boundary) => blocked.push(boundary),
  });
  clock.start(0);
  await waitFor(() => blocked.length === 1);
  equal(clock.index, 0);
  deepStrictEqual(blocked, [1]);
  allowNext = true;
  clock.resume();
  await waitFor(() => clock.index === 2);
  equal(clock.index, 2);
  deepStrictEqual(ticks, [0, 1]);
  clock.destroy();
});
