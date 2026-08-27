import type { Word } from "../../epub/types";
import type { JetstreamPostEvent } from "./types";

export const JETSTREAM_CHAPTER_ID = "bluesky-live";

// Deliberately limited to explicit web URLs. Removing bare domains would also
// erase ordinary dotted prose and usernames with no reliable boundary.
const WEB_URL = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

export function stripWebUrls(text: string): string {
  return text.replace(WEB_URL, " ").replace(/\s+/g, " ").trim();
}

/** Convert only the text a person would see in the post into plain words. */
export function formatJetstreamPost(event: JetstreamPostEvent): Word[] {
  const text = stripWebUrls(event.commit.record.text);
  if (!text) return [];
  const tokens = text.split(/\s+/).filter(Boolean);
  return tokens.map((token, index) => ({
    text: token,
    index,
    metadata: [{ attribute: "chapterId", value: JETSTREAM_CHAPTER_ID }],
    ...(index === tokens.length - 1
      ? { formatting: { lineBreaksAfter: 2 } }
      : {}),
  }));
}
