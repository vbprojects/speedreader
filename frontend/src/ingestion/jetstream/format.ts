import type { Word } from "../../epub/types";
import type { InteractiveFormat, StreamChunk } from "../interactive";
import { asTextPost, hasEnglishLanguageTag, jetstreamEventKey } from "./decode";
import { formatJetstreamPost, JETSTREAM_CHAPTER_ID } from "./formatter";
import { JetstreamClient, type JetstreamSocketFactory } from "./client";
import { hasSensitiveSelfLabel } from "./sensitive-filter";
import { JETSTREAM_ENDPOINTS, JETSTREAM_FORMAT, type JetstreamInput, type JetstreamState } from "./types";

const BATCH_POSTS = 25;
const BATCH_MS = 250;
const RECENT_KEYS = 128;

function initialState(saved?: JetstreamState): JetstreamState {
  if (saved?.schemaVersion === 1) {
    return {
      schemaVersion: 1,
      cursor: typeof saved.cursor === "number" ? saved.cursor : undefined,
      cursorKind: saved.cursorKind,
      lastTimeUs: saved.lastTimeUs,
      recentEventKeys: Array.isArray(saved.recentEventKeys) ? saved.recentEventKeys.slice(-RECENT_KEYS) : [],
      acceptedPostCount: Number.isInteger(saved.acceptedPostCount) ? saved.acceptedPostCount : 0,
    };
  }
  return { schemaVersion: 1, recentEventKeys: [], acceptedPostCount: 0 };
}

export class BlueskyJetstreamFormat implements InteractiveFormat<JetstreamInput, JetstreamState> {
  readonly format = JETSTREAM_FORMAT;
  readonly isDeterministic = false;
  private input: JetstreamInput = {};
  private state: JetstreamState = initialState();
  private readonly socketFactory?: JetstreamSocketFactory;

  constructor(socketFactory?: JetstreamSocketFactory) {
    this.socketFactory = socketFactory;
  }

  async init(input: JetstreamInput = {}, savedState?: JetstreamState) {
    this.input = input;
    this.state = initialState(savedState);
    return { initialState: this.getState(), title: "Bluesky Jetstream", author: "Bluesky" };
  }

  startStreaming(
    startIndex: number,
    onChunk: (chunk: StreamChunk<JetstreamState>) => void,
    onError: (err: Error) => void,
  ): () => void {
    let disposed = false;
    let words: Word[] = [];
    let postCount = 0;
    let stateDirty = false;
    let lastCursorFlushAt = 0;
    const seen = new Set(this.state.recentEventKeys);

    const flush = () => {
      if (disposed || (!stateDirty && words.length === 0)) return;
      if (words.length === 0 && Date.now() - lastCursorFlushAt < 1_000) return;
      const emittedWords = words;
      words = [];
      postCount = 0;
      stateDirty = false;
      lastCursorFlushAt = Date.now();
      onChunk({
        words: emittedWords,
        chapterUpdates: emittedWords.length > 0 ? [{
          chapterId: JETSTREAM_CHAPTER_ID,
          title: "Live posts",
          startIndex: 0,
          endIndex: startIndex + emittedWords.length - 1,
        }] : undefined,
        state: this.getState(),
        isComplete: false,
      });
      startIndex += emittedWords.length;
    };

    const timer = setInterval(flush, BATCH_MS);
    const client = new JetstreamClient({
      endpoints: this.input.endpoints ?? JETSTREAM_ENDPOINTS,
      cursor: this.state.cursor,
      socketFactory: this.socketFactory,
      onError,
      onEvent: (event) => {
        this.state.cursor = event.cursor ?? event.time_us;
        this.state.cursorKind = event.cursor === undefined ? "time-us" : "sequence";
        this.state.lastTimeUs = event.time_us;
        stateDirty = true;
        const post = asTextPost(event);
        if (!post) return;
        const key = jetstreamEventKey(post);
        if (seen.has(key)) return;
        seen.add(key);
        this.state.recentEventKeys.push(key);
        while (this.state.recentEventKeys.length > RECENT_KEYS) {
          const removed = this.state.recentEventKeys.shift();
          if (removed) seen.delete(removed);
        }
        if ((this.input.hideSelfLabeledSensitivePosts ?? true) && hasSensitiveSelfLabel(post)) return;
        if (!hasEnglishLanguageTag(post)) return;
        const postWords = formatJetstreamPost(post);
        if (postWords.length === 0) return;
        const offset = words.length;
        words.push(...postWords.map((word, index) => ({ ...word, index: offset + index })));
        postCount += 1;
        this.state.acceptedPostCount += 1;
        if (postCount >= BATCH_POSTS) flush();
      },
    });
    client.start();
    return () => {
      disposed = true;
      clearInterval(timer);
      client.dispose();
    };
  }

  getState(): JetstreamState {
    return { ...this.state, recentEventKeys: [...this.state.recentEventKeys] };
  }
}
