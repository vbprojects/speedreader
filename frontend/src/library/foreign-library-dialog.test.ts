import { match } from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForeignLibraryRegistry, GutenbergForeignLibrary } from "../foreign-libraries";
import { ForeignLibraryDialog } from "./ForeignLibraryDialog";

test("foreign library selector renders an accessible output-filtered source list", () => {
  const registry = new ForeignLibraryRegistry(() => ({ request: async () => { throw new Error("unused"); } }));
  registry.register(new GutenbergForeignLibrary());
  const html = renderToStaticMarkup(createElement(ForeignLibraryDialog, {
    open: true,
    theme: "light",
    registry,
    onImport: async () => undefined,
    onClose: () => undefined,
  }));
  match(html, /role="dialog"/);
  match(html, /aria-modal="true"/);
  match(html, /Find external content/);
  match(html, /Filter libraries by output type/);
  match(html, /Foreign libraries/);
  match(html, /Project Gutenberg/);
  match(html, />EPUB</);
  match(html, />HTML</);
  match(html, />PDF</);
  match(html, />JSON response</);
  match(html, />SugarCube</);
  match(html, /1 library/);
});
