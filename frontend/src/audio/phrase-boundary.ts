import type { Word } from "../epub/types";

/** Pack complete sentences into one bounded synthesis call. Each separate
 * call can add its own leading/trailing silence, so prefer the last boundary.
 */
export function phraseWordCount(words: readonly Word[], maximum = 24): number {
  const limit = Math.min(words.length, maximum);
  for (let i = limit - 1; i >= 5; i--) {
    if (/[.!?;:][”’"')\]]*$/.test(words[i].text)) return i + 1;
  }
  return limit;
}
