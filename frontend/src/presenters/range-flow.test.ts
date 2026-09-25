import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RangeFlow } from "./RangeFlow";
import { buildReaderFlowRange } from "../interactions/flow";
import { textToStream } from "../ingestion/text";
import { presenters } from "./registry";

test("range layouts render each canonical word once with safe chrome and clipped ranges", async () => {
  const stream = textToStream("one two three four");
  stream.blocks = [{ id: "post", sourceRef: "post", kind: "post", start: 0, end: 4,
    author: "<script>unsafe</script>", url: "javascript:alert(1)", timestamp: "not a date" }];
  const pipeline = presenters.open({ layout: "post-cards", behaviors: [] }, ["posts"]);
  const output = await pipeline.update(stream);
  const nodes = buildReaderFlowRange(stream.words, [], [], 1, 3);
  const html = renderToStaticMarkup(createElement(RangeFlow, { nodes, layouts: output.layouts,
    render: node => node.kind === "word" ? createElement("span", { key: node.word.index, "data-word-index": node.word.index }, node.word.text) : null }));
  assert.equal((html.match(/data-word-index/g) ?? []).length, 2);
  assert.match(html, /<article/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href=|<script>|<time/);
  pipeline.dispose();
});
test("new post chrome is derived outside ingestion and legacy HTML remains available", async () => {
  const stream = textToStream("a post");
  stream.blocks = [{ id: "post", sourceRef: "post", kind: "post", start: 0, end: 2,
    author: "@person", presentationIds: ["post:author", "jetstream:post-separator:post"] }];
  const standard = presenters.open({ layout: "standard", behaviors: [] }, ["posts"]);
  const cards = presenters.open({ layout: "post-cards", behaviors: [] }, ["posts"]);
  assert.equal((await standard.update(stream)).stream.presentations?.length, 2);
  assert.equal((await cards.update(stream)).stream.presentations?.length, 0);
  const legacy = { ...stream, blocks: undefined, presentations: [{ schemaVersion: 1 as const,
    id: "legacy", kind: "html" as const, boundary: 0, html: "<p>Old attribution</p>" }] };
  assert.equal((await cards.update(legacy)).stream.presentations?.[0], legacy.presentations[0]);
  assert.equal(stream.presentations, undefined);
  standard.dispose(); cards.dispose();
});
