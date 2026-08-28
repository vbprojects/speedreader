import type { Book } from "../../db/types";
import type { Word, WordStream } from "../../epub/types";
import { computeMeta } from "../../ingestion/normalize";
import {
  LLM_CHAPTER_ID,
  OPENAI_COMPATIBLE_FORMAT,
  llmInputInteraction,
  type OpenAICompatibleState,
} from "../../ingestion/openai-compatible";

export const LLM_CHAT_BOOK_ID = "builtin:llm-chat:v1";
export const LLM_CHAT_BOOK_REVISION = 1;

const intro = "This is a live conversation with an OpenAI-compatible language model.";

export function createLlmChatStream(): WordStream {
  const words: Word[] = intro.split(/\s+/u).map((text, index) => ({
    text,
    index,
    metadata: [{ attribute: "chapterId", value: LLM_CHAPTER_ID }],
  }));
  return {
    words,
    chapterIndex: [{ chapterId: LLM_CHAPTER_ID, title: "Conversation", startIndex: 0, endIndex: words.length - 1 }],
    meta: { ...computeMeta(words, false), isDeterministic: false },
    interactions: [{ ...llmInputInteraction(0), boundary: words.length }],
  };
}

export function createLlmChatState(): OpenAICompatibleState {
  return { schemaVersion: 1, sessionId: "", turn: 0, messages: [], processedInteractionIds: [] };
}

export function createLlmChatBook(addedAt = Date.now()): Book {
  const stream = createLlmChatStream();
  return {
    id: LLM_CHAT_BOOK_ID,
    title: "LLM Chat",
    author: "OpenAI-compatible endpoint",
    format: OPENAI_COMPATIBLE_FORMAT,
    addedAt,
    wordCount: stream.meta.totalWords,
    chapterCount: stream.chapterIndex.length,
    parserVersion: 1,
    builtIn: true,
    builtInRevision: LLM_CHAT_BOOK_REVISION,
    formatState: createLlmChatState(),
  };
}

export function createLlmChatFixture(addedAt = Date.now()): { book: Book; stream: WordStream } {
  return { book: createLlmChatBook(addedAt), stream: createLlmChatStream() };
}
