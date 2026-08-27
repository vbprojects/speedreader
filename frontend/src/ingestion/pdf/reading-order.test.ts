import { deepStrictEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { extractPageWords, reconstructLines } from "./reading-order";

function item(str: string, x: number, y: number, width = 20) {
  return { str, transform: [12, 0, 0, 12, x, y], width, height: 12, dir: "ltr" };
}

test("PDF line reconstruction preserves reading order and hyphen joining", () => {
  const items = [item("world", 108, 700), item("Hello", 72, 700), item("inter-", 72, 682), item("national", 72, 664)];
  deepStrictEqual(reconstructLines(items).map((line) => line.text), ["Hello world", "inter-", "national"]);
  deepStrictEqual(extractPageWords(items, 1).map((word) => word.text), ["Hello", "world", "international"]);
});

test("PDF line reconstruction handles many attacker-controlled lines without history scans", () => {
  const items = Array.from({ length: 20_000 }, (_, index) => item(`line-${index}`, 72, 400_000 - index * 20));
  const lines = reconstructLines(items.reverse());
  equal(lines.length, 20_000);
  equal(lines[0].text, "line-0");
  equal(lines[19_999].text, "line-19999");
});
