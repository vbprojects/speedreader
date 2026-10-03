import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceSelector } from "./VoiceSelector";

test("Kitten selector exposes all eight voices, precision choices and its model card", () => {
  const html = renderToStaticMarkup(createElement(VoiceSelector, { voice: "kitten_nano_int8_hugo", onChange: () => {} }));
  assert.match(html, /value="kitten" selected/);
  assert.match(html, /aria-label="KittenTTS voice"/);
  assert.match(html, /value="Hugo" selected/);
  for (const name of ["Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo"]) assert.match(html, new RegExp(`>${name}</option>`));
  assert.match(html, /aria-label="KittenTTS quality"/);
  assert.match(html, /INT8 · 24.4 MB/);
  assert.match(html, /FP32 · 56.8 MB/);
  assert.match(html, /Selected voice model and license/);
});
