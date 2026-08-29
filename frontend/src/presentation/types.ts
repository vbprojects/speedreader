export type PresentationView = "rsvp" | "read-along" | "traditional";

/** Inert display content attached to a consumed-word boundary. */
export interface HtmlPresentation {
  schemaVersion: 1;
  id: string;
  /** Number of words consumed before this content is rendered. */
  boundary: number;
  kind: "html";
  /** Untrusted source HTML. It is sanitized immediately before rendering. */
  html: string;
  /** Defaults to both reader views. */
  renderIn?: PresentationView[];
}
