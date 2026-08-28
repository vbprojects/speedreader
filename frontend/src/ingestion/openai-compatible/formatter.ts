import type { Word } from "../../epub/types";

export const LLM_CHAPTER_ID = "llm-chat";

/**
 * The first implementation preserves Markdown as literal text. Keeping this
 * projection pure lets a later incremental Markdown parser replace it without
 * coupling LangGraph or the endpoint client to reader rendering.
 */
export function formatAssistantText(text: string, turnId: string): Word[] {
  return text.trim().split(/\s+/u).filter(Boolean).map((token, index) => ({
    text: token,
    index,
    metadata: [
      { attribute: "chapterId", value: LLM_CHAPTER_ID },
      { attribute: "llmTurnId", value: turnId },
    ],
  }));
}

