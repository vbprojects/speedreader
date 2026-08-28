import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const formatPath = process.argv[2];

if (!formatPath) {
  throw new Error("Usage: node build-fixture.mjs /path/to/sugarcube-2/format.js");
}

const [formatScript, tweeSource] = await Promise.all([
  fs.readFile(formatPath, "utf8"),
  fs.readFile(path.join(here, "fixture.twee"), "utf8"),
]);

let storyFormat;
const sandbox = {
  window: {
    storyFormat(value) {
      storyFormat = value;
    },
  },
};
vm.runInNewContext(formatScript, sandbox, { filename: formatPath, timeout: 5_000 });

if (!storyFormat || storyFormat.name !== "SugarCube" || typeof storyFormat.source !== "string") {
  throw new Error("The supplied file is not a SugarCube Twine 2 format.js");
}

function parseTwee(source) {
  const passages = [];
  let current = null;
  for (const line of source.replaceAll("\r\n", "\n").split("\n")) {
    const match = /^::\s+(.+?)(?:\s+\[([^\]]*)\])?\s*$/.exec(line);
    if (match) {
      if (current) {
        current.text = current.lines.join("\n").replace(/\n+$/, "");
        delete current.lines;
        passages.push(current);
      }
      current = {
        name: match[1],
        tags: match[2]?.trim().split(/\s+/).filter(Boolean) ?? [],
        lines: [],
      };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    current.text = current.lines.join("\n").replace(/\n+$/, "");
    delete current.lines;
    passages.push(current);
  }
  return passages;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const passages = parseTwee(tweeSource);
const title = passages.find((passage) => passage.name === "StoryTitle")?.text.trim();
const storyDataText = passages.find((passage) => passage.name === "StoryData")?.text;
if (!title || !storyDataText) throw new Error("fixture.twee needs StoryTitle and StoryData passages");
const storyData = JSON.parse(storyDataText);

const ordinary = passages.filter((passage) => !["StoryTitle", "StoryData"].includes(passage.name) && !passage.tags.includes("script") && !passage.tags.includes("stylesheet"));
const scripts = passages.filter((passage) => passage.tags.includes("script")).map((passage) => passage.text).join("\n");
const styles = passages.filter((passage) => passage.tags.includes("stylesheet")).map((passage) => passage.text).join("\n");
const startIndex = ordinary.findIndex((passage) => passage.name === storyData.start);
if (startIndex < 0) throw new Error(`Start passage not found: ${storyData.start}`);

const passageNodes = ordinary.map((passage, index) => {
  const tags = escapeHtml(passage.tags.join(" "));
  return `<tw-passagedata pid="${index + 1}" name="${escapeHtml(passage.name)}" tags="${tags}">${escapeHtml(passage.text)}</tw-passagedata>`;
}).join("\n");

const storyDataNode = [
  `<tw-storydata name="${escapeHtml(title)}" startnode="${startIndex + 1}" creator="Speedreader Spike" creator-version="1" ifid="${escapeHtml(storyData.ifid)}" zoom="1" format="SugarCube" format-version="${escapeHtml(storyFormat.version)}" options="" hidden>`,
  `<style role="stylesheet" id="twine-user-stylesheet" type="text/twine-css">${styles}</style>`,
  `<script role="script" id="twine-user-script" type="text/twine-javascript">${scripts}</script>`,
  passageNodes,
  "</tw-storydata>",
].join("\n");

const published = storyFormat.source
  .replaceAll("{{STORY_NAME}}", escapeHtml(title))
  .replace("{{STORY_DATA}}", storyDataNode);

if (published.includes("{{STORY_DATA}}") || !published.includes("id=\"script-sugarcube\"")) {
  throw new Error("SugarCube template substitution failed");
}

const outputPath = path.join(here, "fixture-current.html");
await fs.writeFile(outputPath, published.replace(/[ \t]+$/gm, ""));
process.stdout.write(`Built ${outputPath} with SugarCube ${storyFormat.version}\n`);
