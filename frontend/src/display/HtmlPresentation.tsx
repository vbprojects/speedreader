import { useMemo } from "react";
import type { HtmlPresentation as HtmlPresentationDescriptor, PresentationView } from "../presentation/types";
import { sanitizePresentationHtml } from "../presentation/sanitize";

export function HtmlPresentation({
  presentation,
  view,
}: {
  presentation: HtmlPresentationDescriptor;
  view: PresentationView;
}) {
  const visible = !presentation.renderIn || presentation.renderIn.includes(view);
  const html = useMemo(
    () => visible ? sanitizePresentationHtml(presentation.html) : "",
    [presentation.html, visible],
  );
  if (!visible || !html) return null;
  return (
    <div
      data-presentation-id={presentation.id}
      inert
      tabIndex={-1}
      style={{
        pointerEvents: "none",
        userSelect: "none",
        maxWidth: "100%",
        overflow: "hidden",
        margin: "0.75em 0",
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
