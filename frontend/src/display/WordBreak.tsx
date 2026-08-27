import type { Word } from "../epub/types";

/** Render a stream formatting boundary without creating a paced word. */
export function WordBreak({ word, position = "before" }: { word: Word; position?: "before" | "after" }) {
  const requested = position === "after"
    ? word.formatting?.lineBreaksAfter ?? 0
    : word.formatting?.lineBreaksBefore ?? (word.formatting?.breakBefore === "line" ? 1 : 0);
  const count = Math.max(0, Math.min(8, Math.floor(requested)));
  if (count === 0) return null;
  return Array.from({ length: count }, (_, index) => (
    <br key={index} data-word-break="line" />
  ));
}
