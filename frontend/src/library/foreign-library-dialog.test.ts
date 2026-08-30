import { match } from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArxivForeignLibrary, ForeignLibraryRegistry, GutenbergForeignLibrary, OpenRouterForeignLibrary, TwineForeignLibrary } from "../foreign-libraries";
import { ForeignLibraryDialog } from "./ForeignLibraryDialog";

test("foreign library selector renders an accessible output-filtered source list", () => {
  const registry = new ForeignLibraryRegistry(() => ({ request: async () => { throw new Error("unused"); } }));
  registry.register(new GutenbergForeignLibrary());
  registry.register(new TwineForeignLibrary());
  registry.register(new ArxivForeignLibrary());
  registry.register(new OpenRouterForeignLibrary());
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
  match(html, /Twine on IFDB/);
  match(html, /arXiv/);
  match(html, /OpenRouter Models/);
  match(html, />EPUB</);
  match(html, />HTML</);
  match(html, />PDF</);
  match(html, />JSON response</);
  match(html, />SugarCube</);
  match(html, />LLM model</);
  match(html, /4 libraries/);
});
