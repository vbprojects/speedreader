import type { WordStream } from "../epub/types";
import type { HtmlPresentation } from "../presentation/types";
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** Compatibility chrome is derived at presentation time, never persisted as source. */
export function standardPresentations(stream: Pick<WordStream, "blocks" | "presentations">): HtmlPresentation[] {
  const output = [...(stream.presentations ?? [])];
  const ids = new Set(output.map(item => item.id));
  const add = (id: string, boundary: number, html: string) => {
    if (!ids.has(id)) { output.push({ schemaVersion: 1, id, boundary, kind: "html", html }); ids.add(id); }
  };
  for (const block of stream.blocks ?? []) {
    if (block.kind !== "post") continue;
    if (block.reposter) add(`${block.id}:reposter`, block.start, `<p><strong>${escapeHtml(block.reposter)}</strong> reposted</p>`);
    add(`${block.id}:${block.reposter ? "original-author" : "author"}`, block.authorBoundary ?? block.start,
      `<p><strong>${escapeHtml(block.author ?? "Bluesky post")}</strong></p>`);
    add(`jetstream:post-separator:${block.id}`, block.end, "<br><hr><br>");
  }
  return output.sort((a,b) => a.boundary - b.boundary);
}
