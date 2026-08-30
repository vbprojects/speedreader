import { equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import { extractTwinePackage, InvalidTwineArchiveError } from "./twine-archive";

function story(title: string): string {
  return `<!doctype html><html><head><script id="script-sugarcube"></script></head><body><tw-storydata name="${title}" ifid="IFID-${title}" startnode="1" format="SugarCube"></tw-storydata></body></html>`;
}

async function archive(entries: Record<string, string>): Promise<{ name: string; extension: string; mimeType: string; data: ArrayBuffer }> {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) zip.file(name, value);
  return {
    name: "story.zip",
    extension: "zip",
    mimeType: "application/zip",
    data: await zip.generateAsync({ type: "arraybuffer" }),
  };
}

test("Twine ZIP extraction prefers a root index and returns exact HTML bytes", async () => {
  const selected = story("Root");
  const file = await archive({ "index.html": selected, "docs/about.html": "<p>About</p>", "other/story.html": story("Other") });
  const extracted = await extractTwinePackage(file);
  equal(extracted?.file.name, "index.html");
  equal(extracted?.file.mimeType, "text/html");
  equal(new TextDecoder().decode(extracted?.file.data), selected);
  equal(extracted?.assets.length, 2);
});

test("an HTML gateway response is not treated as ZIP solely because of its planned filename", async () => {
  const html = new TextEncoder().encode(story("Direct"));
  equal(await extractTwinePackage({ name: "fallback.zip", extension: "zip", mimeType: "text/html", data: html.buffer }), null);
});

test("Twine ZIP extraction accepts one nested story and rejects ambiguous or missing stories", async () => {
  const nested = await extractTwinePackage(await archive({ "release/game.html": story("Nested"), "readme.html": "Read me" }));
  equal(nested?.file.name, "game.html");

  await rejects(
    extractTwinePackage(await archive({ "one/story.html": story("One"), "two/story.html": story("Two") })),
    (error: unknown) => error instanceof InvalidTwineArchiveError && /multiple possible/u.test(error.message),
  );
  await rejects(
    extractTwinePackage(await archive({ "index.html": "<main>Not SugarCube</main>" })),
    (error: unknown) => error instanceof InvalidTwineArchiveError && /published SugarCube/u.test(error.message),
  );
});

test("Twine ZIP extraction rejects traversal paths", async () => {
  await rejects(
    extractTwinePackage(await archive({ "../index.html": story("Unsafe") })),
    (error: unknown) => error instanceof InvalidTwineArchiveError && /unsafe file path/u.test(error.message),
  );
});

test("Twine ZIP extraction retains separate local assets", async () => {
  const withAsset = story("Assets").replace("</head>", '<link rel="stylesheet" href="styles/story.css"></head>');
  const extracted = await extractTwinePackage(await archive({ "index.html": withAsset, "styles/story.css": "body{}" }));
  equal(extracted?.assets[0].path, "styles/story.css");
  equal(extracted?.assets[0].mimeType, "text/css");
  equal(new TextDecoder().decode(extracted?.assets[0].data), "body{}");
});
