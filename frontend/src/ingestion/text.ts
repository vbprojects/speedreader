import type { FileInfo, Parser, Word, WordStream } from "./types";
import { computeMeta } from "./normalize";
import { assertFileSize, assertIngestionLimit, INGESTION_LIMITS } from "./limits";

export const SAMPLE_TEXT = `A good reading rhythm leaves room to understand what you read. Start slowly and let each sentence settle before moving on.

Try pausing here. Switch between the single-word view and read-along: the same word stays selected. Use Previous sentence when you want a little more context.

You can close this book and return later. Your place is saved on this device, so your next reading session can begin where this one ends.`;

export function textFile(text: string, title = "Pasted text"): FileInfo {
  return { name: `${title.trim() || "Pasted text"}.txt`, extension: "txt", mimeType: "text/plain", data: new TextEncoder().encode(text).buffer };
}

export function textToStream(text: string, title = "Text"): WordStream {
  assertFileSize(new TextEncoder().encode(text).byteLength);
  const words: Word[] = [];
  for (const [paragraphId, paragraph] of text.trim().split(/\n\s*\n/u).entries()) {
    const tokens = paragraph.trim().split(/\s+/u).filter(Boolean);
    assertIngestionLimit(words.length + tokens.length, INGESTION_LIMITS.maxEpubWords, "Text words");
    tokens.forEach((token, offset) => words.push({
      text: token, index: words.length,
      metadata: [{ attribute: "chapterId", value: 0 }, { attribute: "paragraphId", value: paragraphId }],
      ...(offset === 0 && paragraphId > 0 ? { formatting: { lineBreaksBefore: 2 } } : {}),
    }));
  }
  if (!words.length) throw new Error("No readable text found. Paste some text or choose a file containing selectable text.");
  return { words, chapterIndex: [{ chapterId: 0, title, startIndex: 0, endIndex: words.length - 1 }], meta: computeMeta(words) };
}

export class TextParser implements Parser {
  readonly format = "txt";
  canParse(file: FileInfo) { return file.extension.toLowerCase() === "txt" || file.mimeType === "text/plain"; }
  async parse(file: FileInfo) { return textToStream(new TextDecoder().decode(file.data), file.name.replace(/\.[^.]+$/, "")); }
}

/** Extract inert text from saved webpages. Never attach the source DOM to the page. */
export class HtmlTextParser implements Parser {
  readonly format = "html";
  constructor(private parseHtml = (html: string) => new DOMParser().parseFromString(html, "text/html")) {}
  canParse(file: FileInfo) { return /^(html|htm)$/i.test(file.extension) || file.mimeType === "text/html"; }
  async parse(file: FileInfo) {
    assertFileSize(file.data.byteLength);
    const document = this.parseHtml(new TextDecoder().decode(file.data));
    if (document.querySelector("tw-storydata")) throw new Error("This interactive story format is not supported. Choose published SugarCube HTML or paste a passage as text.");
    document.querySelectorAll("script,style,template,noscript,nav,header,footer,aside,form,iframe,object,embed,[hidden],[aria-hidden='true']").forEach((element) => element.remove());
    const root = document.querySelector("article,main,[role='main']") ?? document.body;
    root.querySelectorAll("p,div,section,h1,h2,h3,h4,h5,h6,li,blockquote,br").forEach((element) => {
      element.before(document.createTextNode("\n\n"));
      element.after(document.createTextNode("\n\n"));
    });
    return textToStream(root.textContent ?? "", document.title || file.name);
  }
  async getBookInfo(file: FileInfo) {
    const document = this.parseHtml(new TextDecoder().decode(file.data));
    return { title: document.title || file.name.replace(/\.[^.]+$/, ""), author: document.querySelector('meta[name="author"]')?.getAttribute("content") || "Unknown author" };
  }
}
