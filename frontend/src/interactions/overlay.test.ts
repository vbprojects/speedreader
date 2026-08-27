import { match } from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InteractionOverlay } from "./InteractionOverlay";

test("overlay renders blocking accessible controls without source HTML", () => {
  const html = renderToStaticMarkup(
    createElement(InteractionOverlay, {
      interaction: {
        schemaVersion: 1,
        id: "name",
        boundary: 0,
        kind: "text-input",
        label: "Your name",
        prompt: "Tell the story who you are.",
      },
      onSubmit: () => undefined,
    }),
  );
  match(html, /role="dialog"/);
  match(html, /aria-modal="true"/);
  match(html, /aria-label="Your name"/);
  match(html, /Tell the story who you are\./);
  match(html, /font-size:16px/);
  match(html, /text-align:center/);
  match(html, /min\(calc\(100vw - 32px\), 520px\)/);
});
