import type { Word } from "../../epub/types";
import type { JetstreamPostEvent } from "./types";

export const JETSTREAM_CHAPTER_ID = "bluesky-live";

/** Convert only the DID, a literal separator, and post text into plain words. */
export function formatJetstreamPost(event: JetstreamPostEvent): Word[] {
  const text = event.commit.record.text.replace(/\s+/g, " ").trim();
  const tokens = `${event.did} : ${text}`.split(/\s+/).filter(Boolean);
  return tokens.map((token, index) => ({
    text: token,
    index,
    metadata: [{ attribute: "chapterId", value: JETSTREAM_CHAPTER_ID }],
  }));
}
