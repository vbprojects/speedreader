import { doesNotMatch, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("touch text controls prevent focus zoom without disabling pinch zoom", () => {
  const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  match(css, /@media \(any-pointer: coarse\)/u);
  match(css, /textarea,\s*select\s*\{\s*font-size: 16px !important;/u);
  match(css, /touch-action: manipulation;/u);
  doesNotMatch(html, /(?:user-scalable\s*=\s*no|maximum-scale\s*=\s*1)/iu);
});
