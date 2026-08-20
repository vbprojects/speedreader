// test-navtree.mts
// Headless verification of the navigation tree builder.
//
// Usage (from frontend/):
//   npx tsx experiments/test-navtree.mts

import { buildNavTree, findNodePath } from "../src/navigation/tree.ts";
import type { Word } from "../src/epub/types.ts";

function makeWords(): Word[] {
  // Simulate a stream with hierarchy: chapterId → sectionId → paragraphId.
  const words: Word[] = [];
  let i = 0;
  const push = (chapter: number, section: number, paragraph: number, text: string) => {
    words.push({
      text,
      index: i++,
      metadata: [
        { attribute: "chapterId", value: chapter },
        { attribute: "sectionId", value: section },
        { attribute: "paragraphId", value: paragraph },
      ],
    });
  };
  push(0, 0, 0, "alpha");
  push(0, 0, 0, "beta");
  push(0, 1, 0, "gamma");
  push(1, 0, 0, "delta");
  push(1, 0, 1, "epsilon");
  return words;
}

async function main() {
  const words = makeWords();
  const chapterIndex = [
    { chapterId: 0, title: "Chapter One", startIndex: 0, endIndex: 2 },
    { chapterId: 1, title: "Chapter Two", startIndex: 3, endIndex: 4 },
  ];

  const tree = buildNavTree(words, chapterIndex);
  console.log("=== Tree levels ===");
  console.log(tree.levels.join(" → "));

  console.log("\n=== Roots ===");
  for (const r of tree.roots) {
    console.log(`  [${r.attribute}=${r.value}] "${r.label}" (${r.startIndex}..${r.endIndex}) children=${r.children.length}`);
    for (const s of r.children) {
      console.log(`    [${s.attribute}=${s.value}] (${s.startIndex}..${s.endIndex}) children=${s.children.length}`);
    }
  }

  console.log("\n=== findNodePath at index 4 (should be ch1 → sec0 → para1) ===");
  const path = findNodePath(tree, 4);
  console.log(path.map((n) => `${n.attribute}=${n.value}`).join(" / "));

  console.log("\n=== findNodePath at index 1 (should be ch0 → sec0 → para0) ===");
  const path2 = findNodePath(tree, 1);
  console.log(path2.map((n) => `${n.attribute}=${n.value}`).join(" / "));

  // Dynamic depth: cap at 2 levels.
  console.log("\n=== maxDepth=2 ===");
  const tree2 = buildNavTree(words, chapterIndex, 2);
  console.log("levels:", tree2.levels.join(" → "));
  console.log("root children:", tree2.roots[0].children.length, "(sections, no paragraphs)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});