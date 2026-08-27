import createDOMPurify, { type WindowLike } from "dompurify";

const ALLOWED_TAGS = [
  "div", "span", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "ul", "ol", "li", "blockquote", "pre", "code",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
];

const ALLOWED_ATTR = ["aria-hidden", "aria-label", "role", "colspan", "rowspan"];

/** Sanitize presentation HTML with no active controls, resources, or styling. */
export function sanitizePresentationHtml(
  html: string,
  targetWindow: WindowLike = window as unknown as WindowLike,
): string {
  const purifier = createDOMPurify(targetWindow);
  return purifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}
