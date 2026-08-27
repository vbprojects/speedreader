import type { Word } from "../../epub/types";
import type { JetstreamPostEvent } from "./types";

export const JETSTREAM_CHAPTER_ID = "bluesky-live";

// Deliberately limited to explicit web URLs. Removing bare domains would also
// erase ordinary dotted prose and usernames with no reliable boundary.
const WEB_URL = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

export function stripWebUrls(text: string): string {
  return text.replace(WEB_URL, " ").replace(/\s+/g, " ").trim();
}

export function formatJetstreamText(text: string): Word[] {
  const visibleText = stripWebUrls(text);
  if (!visibleText) return [];
  return visibleText.split(/\s+/).filter(Boolean).map((token, index) => ({
    text: token,
    index,
    metadata: [{ attribute: "chapterId", value: JETSTREAM_CHAPTER_ID }],
  }));
}

/** Convert only the text a person would see in the post into plain words. */
export function formatJetstreamPost(event: JetstreamPostEvent): Word[] {
  return formatJetstreamText(event.commit.record.text);
}
