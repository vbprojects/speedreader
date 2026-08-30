import { match, doesNotMatch } from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NumericSettingControl } from "./NumericSettingControl";
import { PacingPreview } from "./PacingPreview";
import { themeTokens } from "./themes";
import { DEFAULT_GLOBAL_SETTINGS } from "./types";

test("numeric setting renders an editable value and precise adjusters", () => {
  const html = renderToStaticMarkup(createElement(NumericSettingControl, {
    label: "Reading speed",
    value: 600,
    min: 100,
    max: 2000,
    step: 50,
    unit: "WPM",
    tokens: themeTokens("light"),
    onChange: () => undefined,
  }));

  match(html, /Reading speed/u);
  match(html, /aria-label="Reading speed value"/u);
  match(html, /aria-label="Decrease Reading speed"/u);
  match(html, /aria-label="Increase Reading speed"/u);
});

test("n-gram size is a discrete stepper rather than a drag range", () => {
  const html = renderToStaticMarkup(createElement(NumericSettingControl, {
    label: "Character n-gram size",
    value: 3,
    min: 1,
    max: 8,
    step: 1,
    showRange: false,
    tokens: themeTokens("light"),
    onChange: () => undefined,
  }));

  match(html, /aria-label="Character n-gram size value"/u);
  doesNotMatch(html, /type="range"[^>]*aria-label="Character n-gram size"/u);
});

test("pacing preview exposes the histogram, pulse value, and playback control", () => {
  const html = renderToStaticMarkup(createElement(PacingPreview, {
    settings: {
      ...DEFAULT_GLOBAL_SETTINGS,
      pacingModel: "surprisal-normal",
    },
    tokens: themeTokens("light"),
  }));

  match(html, /Timing preview/u);
  match(html, /Histogram of preview word timings/u);
  match(html, /ms display/u);
  match(html, /Play timing/u);
});
