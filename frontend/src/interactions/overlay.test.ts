import { doesNotMatch, match } from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InteractionOverlay } from "./InteractionOverlay";
import { ChoiceInteraction } from "./ChoiceInteraction";
import { TextInputInteraction } from "./TextInputInteraction";

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
  match(html, /<label[^>]*for=/);
  match(html, /Tell the story who you are\./);
  match(html, /font-size:16px/);
  match(html, /text-align:left/);
  match(html, /min\(calc\(100vw - 32px\), 520px\)/);
});

test("inline text inputs do not steal focus and expose native constraints", () => {
  const html = renderToStaticMarkup(
    createElement(TextInputInteraction, {
      interaction: {
        schemaVersion: 1,
        id: "display name",
        boundary: 1,
        kind: "text-input",
        label: "Display name",
        constraints: { required: true, minLength: 2, maxLength: 40 },
      },
      inline: true,
      onSubmit: () => undefined,
    }),
  );
  doesNotMatch(html, /autofocus/);
  match(html, /required=""/);
  match(html, /minLength="2"/);
  match(html, /maxLength="40"/);
});

test("single choices use radio semantics and focus the first available modal option", () => {
  const html = renderToStaticMarkup(
    createElement(ChoiceInteraction, {
      interaction: {
        schemaVersion: 1,
        id: "path",
        boundary: 1,
        kind: "single-choice",
        prompt: "Choose a path",
        submitLabel: "Confirm path",
        options: [
          { id: "closed", label: "Closed", disabled: true },
          { id: "open", label: "Open" },
        ],
      },
      onSubmit: () => undefined,
    }),
  );
  doesNotMatch(html, /aria-pressed/);
  match(html, /type="radio"/);
  match(html, /<input(?=[^>]*value="closed")(?=[^>]*disabled="")[^>]*>/);
  match(html, /<input(?=[^>]*value="open")(?=[^>]*autofocus="")[^>]*>/);
  match(html, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>Confirm path<\/button>/);
});
