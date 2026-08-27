import type { HtmlPresentation, PresentationView } from "./types";
import { sanitizePresentationHtml } from "./sanitize";

const VIEWS = new Set<PresentationView>(["rsvp", "traditional"]);

/** Validate JSON-safe inert presentation descriptors at word boundaries. */
export function validatePresentations(
  presentations: HtmlPresentation[] = [],
  totalWords: number,
): HtmlPresentation[] {
  const ids = new Set<string>();
  return presentations.map((presentation) => {
    if (presentation.schemaVersion !== 1 || presentation.kind !== "html") {
      throw new Error("unsupported presentation descriptor");
    }
    if (!presentation.id.trim()) throw new Error("presentation id is required");
    if (ids.has(presentation.id)) throw new Error("duplicate presentation id: " + presentation.id);
    ids.add(presentation.id);
    if (!Number.isInteger(presentation.boundary) || presentation.boundary < 0 || presentation.boundary > totalWords) {
      throw new Error("presentation boundary is outside the word stream: " + presentation.id);
    }
    const html = typeof window === "undefined"
      ? presentation.html
      : sanitizePresentationHtml(presentation.html);
    if (!html.trim()) throw new Error("presentation html is required: " + presentation.id);
    if (presentation.renderIn?.some((view) => !VIEWS.has(view))) {
      throw new Error("unsupported presentation view: " + presentation.id);
    }
    return {
      ...presentation,
      html,
      ...(presentation.renderIn ? { renderIn: [...presentation.renderIn] } : {}),
    };
  });
}
