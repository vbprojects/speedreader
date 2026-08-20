// test-display.mts
// Headless verification of the display Clock + Renderer (pure logic).
// The React component needs a browser, but these are testable in Node.
//
// Usage (from frontend/):
//   npx tsx experiments/test-display.mts

import { SelfCorrectingClock } from "../src/display/clock.ts";
import { buildFrame, adaptiveWindow } from "../src/display/renderer.ts";
import type { Word } from "../src/epub/types.ts";

function makeWords(n: number): Word[] {
  return Array.from({ length: n }, (_, i) => ({
    text: `word${i}`,
    index: i,
    metadata: [{ attribute: "chapterId", value: 0 }],
  }));
}

async function main() {
  // --- Renderer ---
  const words = makeWords(10);
  const frame = buildFrame(words, 5, { window: { before: 3, after: 3 }, adaptiveWindow: false, wpm: 600 });
  console.log("=== Renderer (index 5, window 3/3) ===");
  console.log("current:", frame.current.text);
  console.log("before:", frame.before.map((w) => w.text).join(" "));
  console.log("after:", frame.after.map((w) => w.text).join(" "));

  // Edge: index 0
  const edge = buildFrame(words, 0, { window: { before: 3, after: 3 }, adaptiveWindow: false, wpm: 600 });
  console.log("\nEdge index 0 -> before:", edge.before.length, "after:", edge.after.length);

  // Adaptive window
  console.log("\n=== Adaptive window ===");
  console.log("wpm=600 ->", adaptiveWindow(600, 3));
  console.log("wpm=200 ->", adaptiveWindow(200, 3));
  console.log("wpm=1000 ->", adaptiveWindow(1000, 3));

  // --- Clock ---
  console.log("\n=== Clock (durations [50,50,50,50,50]) ===");
  const ticks: number[] = [];
  const clock = new SelfCorrectingClock({
    durations: [50, 50, 50, 50, 50],
    onTick: (i) => ticks.push(i),
    onEnd: () => console.log("clock ended"),
  });
  clock.start(0);
  await new Promise((r) => setTimeout(r, 320));
  console.log("ticks:", ticks.join(","));
  console.log("final index:", clock.index, "running:", clock.running);
  clock.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
