import type { Word } from "../../epub/types";
import type { HtmlPresentation } from "../../presentation/types";
import type { InteractiveFormat, StreamChunk } from "../interactive";
import { asRepost, asTextPost, hasEnglishLanguageTag, jetstreamCommitKey } from "./decode";
import { formatJetstreamPost, formatJetstreamText, JETSTREAM_CHAPTER_ID } from "./formatter";
import { JetstreamClient, type JetstreamSocketFactory } from "./client";
import { hasSensitiveSelfLabel } from "./sensitive-filter";
import { JETSTREAM_ENDPOINTS, JETSTREAM_FORMAT, type JetstreamInput, type JetstreamState } from "./types";
import { PublicBlueskyEnricher, type JetstreamEnricher } from "./enrichment";

const BATCH_POSTS = 25;
const BATCH_MS = 250;
const RECENT_KEYS = 128;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function quoteUri(record: Record<string, unknown>): string | null {
  const embed = object(record.embed);
  if (!embed) return null;
  if (embed.$type === "app.bsky.embed.record") {
    const reference = object(embed.record);
    return typeof reference?.uri === "string" ? reference.uri : null;
  }
  if (embed.$type === "app.bsky.embed.recordWithMedia") {
    const recordEmbed = object(embed.record);
    const reference = object(recordEmbed?.record);
    return typeof reference?.uri === "string" ? reference.uri : null;
  }
  return null;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

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
  private readonly enricher: JetstreamEnricher;

  constructor(socketFactory?: JetstreamSocketFactory, enricher: JetstreamEnricher = new PublicBlueskyEnricher()) {
    this.socketFactory = socketFactory;
    this.enricher = enricher;
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
    let presentations: HtmlPresentation[] = [];
    let postCount = 0;
    let stateDirty = false;
    let lastCursorFlushAt = 0;
    let eventQueue = Promise.resolve();
    const seen = new Set(this.state.recentEventKeys);

    const addPresentation = (id: string, html: string) => {
      presentations.push({ schemaVersion: 1, id, boundary: words.length, kind: "html", html });
    };

    const appendWords = (newWords: Word[]) => {
      const offset = words.length;
      words.push(...newWords.map((word, index) => ({ ...word, index: offset + index })));
    };

    const actorLabel = async (did: string): Promise<string> => {
      const actor = await this.enricher.actor(did);
      return `@${actor?.handle ?? did}`;
    };

    const finishPost = (key: string) => {
      presentations.push({
        schemaVersion: 1,
        id: `jetstream:post-separator:${key}`,
        boundary: words.length,
        kind: "html",
        html: "<br><hr><br>",
      });
      postCount += 1;
      this.state.acceptedPostCount += 1;
      if (postCount >= BATCH_POSTS) flush();
    };

    const flush = () => {
      if (disposed || (!stateDirty && words.length === 0)) return;
      if (words.length === 0 && Date.now() - lastCursorFlushAt < 1_000) return;
      const emittedWords = words;
      const emittedPresentations = presentations;
      words = [];
      presentations = [];
      postCount = 0;
      stateDirty = false;
      lastCursorFlushAt = Date.now();
      onChunk({
        words: emittedWords,
        presentations: emittedPresentations,
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
        const repost = asRepost(event);
        if (!post && !repost) return;
        const key = jetstreamCommitKey(event);
        if (seen.has(key)) return;
        seen.add(key);
        this.state.recentEventKeys.push(key);
        while (this.state.recentEventKeys.length > RECENT_KEYS) {
          const removed = this.state.recentEventKeys.shift();
          if (removed) seen.delete(removed);
        }
        eventQueue = eventQueue.then(async () => {
          if (disposed) return;
          if (post) {
            if ((this.input.hideSelfLabeledSensitivePosts ?? true) && hasSensitiveSelfLabel(post)) return;
            if (!hasEnglishLanguageTag(post)) return;
            const postWords = formatJetstreamPost(post);
            if (postWords.length === 0) return;

            const quotedUri = quoteUri(post.commit.record);
            if (quotedUri) {
              const quoted = await this.enricher.post(quotedUri);
              if (quoted) {
                const quotedWords = formatJetstreamText(quoted.text);
                if (quotedWords.length > 0) {
                  addPresentation(`${key}:quoted-author`, `<p><strong>${escapeHtml(`@${quoted.author.handle}`)}</strong> · quoted</p>`);
                  appendWords(quotedWords);
                  addPresentation(`${key}:quote-gap`, "<br>");
                }
              }
            }

            addPresentation(`${key}:author`, `<p><strong>${escapeHtml(await actorLabel(post.did))}</strong></p>`);
            appendWords(postWords);
            finishPost(key);
            return;
          }

          const original = await this.enricher.post(repost!.commit.record.subject.uri);
          if (!original || (original.langs && !original.langs.some((lang) => /^en(?:-|$)/i.test(lang)))) return;
          const originalWords = formatJetstreamText(original.text);
          if (originalWords.length === 0) return;
          addPresentation(`${key}:reposter`, `<p><strong>${escapeHtml(await actorLabel(repost!.did))}</strong> reposted</p>`);
          addPresentation(`${key}:original-author`, `<p><strong>${escapeHtml(`@${original.author.handle}`)}</strong></p>`);
          appendWords(originalWords);
          finishPost(key);
        }).catch((error: unknown) => onError(error instanceof Error ? error : new Error(String(error))));
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
