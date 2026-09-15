import type { Word } from "../epub/types";

/** Prefer source structure; fall back to sentence-ending punctuation. */
export function sentenceStarts(words: Word[]): number[] {
  const starts = words.length ? [0] : [];
  for (let index = 1; index < words.length; index++) {
    const previous = words[index - 1];
    const word = words[index];
    const structuralBoundary = ["chapterId", "paragraphId", "sentenceId", "llmTurnId", "postId"].some((attribute) =>
      word.metadata.find((item) => item.attribute === attribute)?.value !== previous.metadata.find((item) => item.attribute === attribute)?.value);
    const sentenceEnd = /[.!?…]["'”’»\])}]*$/u.test(previous.text)
      && !/^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.$/iu.test(previous.text)
      && !/^[A-Z]\.$/u.test(previous.text);
    if (structuralBoundary || sentenceEnd || (word.formatting?.lineBreaksBefore ?? 0) > 1) starts.push(index);
  }
  return starts;
}

export function sentenceDestination(starts: number[], index: number, direction: -1 | 1, wordCount: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] < index) low = middle + 1;
    else high = middle;
  }
  if (direction < 0) return starts[Math.max(0, low - 1)] ?? 0;
  const next = starts[low] === index ? low + 1 : low;
  return starts[next] ?? Math.max(0, wordCount - 1);
}
