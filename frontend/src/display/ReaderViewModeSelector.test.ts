import { match } from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReaderViewModeSelector } from "./ReaderViewModeSelector";

test("view selector exposes two persistent toggle options", () => {
  const html = renderToStaticMarkup(createElement(ReaderViewModeSelector, {
    value: "read-along",
    onChange: () => undefined,
  }));
  match(html, /role="group"/);
  match(html, /aria-label="Reading view"/);
  match(html, />RSVP<\/button>/);
  match(html, /aria-pressed="true"[^>]*>Read along<\/button>/);
});
