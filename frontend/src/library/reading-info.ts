import type { Book, ReaderState } from "../db/types";
import type { WordStream } from "../epub/types";

export function availability(book: Book): string {
  if (book.format === "sugarcube-2-runtime") return "Reader engine unavailable";
  if (book.format === "bluesky-jetstream" || book.format === "openai-compatible-llm") {
    return "Requires connection for new content";
  }
  return "Available offline";
}

export function lastReadBook(books: Book[], states: Record<string, ReaderState>): Book | undefined {
  return books.filter((book) => states[book.id]?.lastOpenedAt > 0)
    .sort((a, b) => states[b.id].lastOpenedAt - states[a.id].lastOpenedAt)[0];
}

export function readingMinutes(wordCount: number, wpm: number): number {
  return Math.max(1, Math.ceil(wordCount / (Number.isFinite(wpm) && wpm > 0 ? wpm : 300)));
}

export function streamText(stream: WordStream): string {
  return stream.words.map((word, index) => {
    const previous = stream.words[index - 1];
    const paragraph = word.metadata.find((item) => item.attribute === "paragraphId")?.value;
    const previousParagraph = previous?.metadata.find((item) => item.attribute === "paragraphId")?.value;
    const breaks = word.formatting?.lineBreaksBefore || word.formatting?.breakBefore || previous?.formatting?.lineBreaksAfter;
    return `${index ? breaks || paragraph !== previousParagraph ? "\n\n" : " " : ""}${word.text}`;
  }).join("");
}

export function importRecovery(message: string): string {
  if (/fetch|network|cors|reach|load failed|offline/i.test(message)) return "Check your connection, or download the file from its source page and use Import file.";
  if (/no readable|empty|scanned|ocr|text layer/i.test(message)) return "Try a file with selectable text, or paste the text you want to read.";
  if (/format|parser|sugarcube|unsupported/i.test(message)) return "Choose EPUB, PDF, TXT, a saved webpage, or published SugarCube HTML/ZIP. You can also paste text.";
  return "Try importing the file again, choose another file, or paste its readable text.";
}
