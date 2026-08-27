import { equal } from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Word } from "../epub/types";
import { WordBreak } from "./WordBreak";

const word = (formatting?: Word["formatting"]): Word => ({
  text: "word",
  index: 0,
  metadata: [],
  formatting,
});

test("word breaks render an inspectable br only for formatted words", () => {
  equal(renderToStaticMarkup(createElement(WordBreak, { word: word() })), "");
  equal(
    renderToStaticMarkup(createElement(WordBreak, { word: word({ lineBreaksBefore: 1 }) })),
    '<br data-word-break="line"/>'
  );
  equal(
    renderToStaticMarkup(createElement(WordBreak, { word: word({ lineBreaksBefore: 3 }) })),
    '<br data-word-break="line"/><br data-word-break="line"/><br data-word-break="line"/>'
  );
  equal(
    renderToStaticMarkup(createElement(WordBreak, { word: word({ breakBefore: "line" }) })),
    '<br data-word-break="line"/>'
  );
  equal(
    renderToStaticMarkup(createElement(WordBreak, { word: word({ lineBreaksAfter: 2 }), position: "after" })),
    '<br data-word-break="line"/><br data-word-break="line"/>'
  );
});
