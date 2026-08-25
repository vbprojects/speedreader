// test-display.mts
// Headless verification of the display Clock + Renderer (pure logic).
// The React component needs a browser, but these are testable in Node.
//
// Usage (from frontend/):
//   npx tsx experiments/test-display.mts

import { SelfCorrectingClock } from "../src/display/clock.ts";
import { buildFrame } from "../src/display/renderer.ts";
import { getOrpIndex } from "../src/display/SpeedReader.tsx";
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
  const frame = buildFrame(words, 5, { wpm: 600 });
  console.log("=== Renderer (index 5) ===");
  console.log("current:", frame.current.text);
  console.log("index:", frame.index);

  // Edge: index 0
  const edge = buildFrame(words, 0, { wpm: 600 });
  console.log("\nEdge index 0 -> current:", edge.current.text, "index:", edge.index);

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

  // --- Restored paused position ---
  // This mirrors SpeedReader's initialization path: the clock must retain a
  // non-zero restored index even before playback starts.
  const restored = new SelfCorrectingClock({
    durations: [100, 100, 100, 100, 100],
    onTick: () => undefined,
  });
  restored.seek(3);
  console.log("\nRestored paused index:", restored.index === 3 ? "PASS" : `FAIL (${restored.index})`);
  restored.resume();
  console.log("Resume keeps restored index:", restored.index === 3 ? "PASS" : `FAIL (${restored.index})`);
  restored.destroy();

  // --- ORP Focal Index Tests ---
  console.log("\n=== ORP (Optimal Recognition Point) ===");
  console.log("ORP 'a' (len 1):", getOrpIndex("a") === 0 ? "PASS" : `FAIL (${getOrpIndex("a")})`);
  console.log("ORP 'the' (len 3):", getOrpIndex("the") === 1 ? "PASS" : `FAIL (${getOrpIndex("the")})`);
  console.log("ORP 'reading' (len 7):", getOrpIndex("reading") === 2 ? "PASS" : `FAIL (${getOrpIndex("reading")})`);
  console.log("ORP 'speedreader' (len 11):", getOrpIndex("speedreader") === 3 ? "PASS" : `FAIL (${getOrpIndex("speedreader")})`);
  console.log("ORP 'incomprehensible' (len 16):", getOrpIndex("incomprehensible") === 4 ? "PASS" : `FAIL (${getOrpIndex("incomprehensible")})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
