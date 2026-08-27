import { deepStrictEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import type { Word } from "../epub/types";
import { buildNavTree, findNodePath } from "./tree";

function word(index: number, chapter: string | number, paragraph: number): Word {
  return {
    text: `w${index}`,
    index,
    metadata: [
      { attribute: "chapterId", value: chapter },
      { attribute: "paragraphId", value: paragraph },
    ],
  };
}

test("navigation preserves typed values, titles, ranges, and path lookup", () => {
  const words = [word(0, 1, 0), word(1, "1", 0), word(2, "1", 1)];
  const tree = buildNavTree(words, [{ chapterId: "1", title: "String chapter", startIndex: 1, endIndex: 2 }]);
  equal(tree.roots.length, 2);
  equal(tree.roots[0].label, "1");
  equal(tree.roots[1].label, "String chapter");
  deepStrictEqual(findNodePath(tree, 2).map((node) => node.value), ["1", 1]);
});

test("navigation builds and searches many sibling nodes", () => {
  const words = Array.from({ length: 20_000 }, (_, index) => word(index, 0, index));
  const tree = buildNavTree(words);
  equal(tree.roots[0].children.length, 20_000);
  deepStrictEqual(findNodePath(tree, 19_999).map((node) => node.value), [0, 19_999]);
});

test("navigation indexes overlapping ranges without backward sibling scans", () => {
  const words = Array.from({ length: 20_001 }, (_, index) => word(index, index === 20_000 ? 0 : index, 0));
  const tree = buildNavTree(words, undefined, 1);
  equal(tree.roots.length, 20_000);
  equal(tree.roots[0].endIndex, 20_000);
  for (let i = 0; i < 1_000; i++) equal(findNodePath(tree, 20_000)[0].value, 0);
});
