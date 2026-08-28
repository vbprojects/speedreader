import { equal } from "node:assert/strict";
import { test } from "node:test";
import { OPENAI_COMPATIBLE_FORMAT } from "../../ingestion/openai-compatible";
import { validateInteractions } from "../../interactions/validation";
import { createLlmChatFixture, LLM_CHAT_BOOK_ID, LLM_CHAT_BOOK_REVISION } from "./llm-chat";

test("LLM Chat is an incomplete built-in stream with one text action", () => {
  const { book, stream } = createLlmChatFixture(123);
  equal(book.id, LLM_CHAT_BOOK_ID);
  equal(book.format, OPENAI_COMPATIBLE_FORMAT);
  equal(book.builtIn, true);
  equal(book.builtInRevision, LLM_CHAT_BOOK_REVISION);
  equal(stream.meta.isComplete, false);
  equal(stream.interactions?.length, 1);
  equal(validateInteractions(stream.interactions ?? [], stream.words.length)[0].kind, "text-input");
  equal(stream.interactions?.[0].boundary, stream.words.length);
  equal(JSON.parse(JSON.stringify(stream)).interactions[0].id, "llm:input:0");
});

