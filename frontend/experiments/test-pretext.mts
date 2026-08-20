// test-pretext.mts
// Headless verification of the Pretext-based layout (Option B centering).
//
// Usage (from frontend/):
//   npx tsx experiments/test-pretext.mts

import { measureTextWidth, layoutLine, centerTranslate, totalWidth, fitFontSize } from "../src/display/pretext-layout.ts";
import type { Word } from "../src/epub/types.ts";

function makeWords(texts: string[]): Word[] {
  return texts.map((text, i) => ({
    text,
    index: i,
    metadata: [{ attribute: "chapterId", value: 0 }],
  }));
}

async function main() {
  const words = makeWords(["the", "quick", "brown", "fox", "jumps", "over", "the", "lazy", "dog"]);
  const font = "28px system-ui";
  const before = words.slice(0, 4);
  const current = words[4];
  const after = words.slice(5);

  console.log("=== measureTextWidth ===");
  console.log(`"fox" width: ${measureTextWidth("fox", font).toFixed(1)}px`);

  console.log("\n=== layoutLine ===");
  const layout = layoutLine(before, current, after, font);
  console.log(`beforeWidth: ${layout.beforeWidth.toFixed(1)}, currentWidth: ${layout.currentWidth.toFixed(1)}, afterWidth: ${layout.afterWidth.toFixed(1)}`);

  console.log("\n=== totalWidth / centerTranslate (800px) ===");
  console.log(`total: ${totalWidth(layout).toFixed(1)}px`);
  console.log(`translateX: ${centerTranslate(layout, 800).toFixed(1)}px`);

  console.log("\n=== fitFontSize (400px, base 28) ===");
  console.log(`fits: ${fitFontSize(words, "Verdana", 400, 28)}px`);

  console.log("\nNOTE: Pretext needs a canvas context; this runs in browser/Tauri only.");
}

main().catch((e) => {
  console.error(e);
  console.error("Expected: Pretext requires a canvas (OffscreenCanvas or DOM canvas). This test is browser-only.");
  process.exit(1);
});