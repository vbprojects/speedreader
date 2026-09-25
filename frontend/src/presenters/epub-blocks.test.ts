import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { extractEpubSection } from "../ingestion/epub-parser";
import { epubBlocks, validateBlocks } from "./blocks";
import { computeMeta } from "../ingestion/normalize";

test("EPUB extraction preserves heading ranges, inline children, nested blocks and stable references", () => {
  const document = new JSDOM("<h2 id='chapter'>A <em>chapter</em></h2><div>Before<p>Nested <b>paragraph</b></p>After</div><p>Last line<br>next line</p><script>never speak</script>").window.document;
  const extract = () => {
    const { words } = extractEpubSection(document.body, 3);
    return { words, chapterIndex: [], meta: computeMeta(words) };
  };
  const stream = extract();
  const blocks = validateBlocks(epubBlocks(stream), stream.words.length);
  assert.deepEqual(blocks, epubBlocks(extract()));
  assert.deepEqual(blocks.map(block => [block.kind, stream.words.slice(block.start, block.end).map(word => word.text).join(" ")]), [
    ["heading", "A chapter"], ["paragraph", "Before"], ["paragraph", "Nested paragraph"],
    ["paragraph", "After"], ["paragraph", "Last line next line"],
  ]);
  assert.equal(blocks[0].level, 2);
  assert.ok(blocks.every(block => block.sourceRef.startsWith("spine:3/")));
  assert.equal(stream.words.find(word => word.text === "next")?.formatting?.lineBreaksBefore, 1);
});
