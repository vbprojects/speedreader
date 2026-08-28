import type { ReaderEngineEvent } from "../../engine-events/types";
import type { ReaderInteraction } from "../../interactions/types";
import type { InteractiveFormat, StreamChunk } from "../interactive";
import { normalizeOpenAIBaseUrl, OpenAICompatibleClient, type FetchLike } from "./client";
import { formatAssistantText, LLM_CHAPTER_ID } from "./formatter";
import { createLlmGraph, type LlmGraphDependencies } from "./graph";
import {
  OPENAI_COMPATIBLE_FORMAT,
  type OpenAICompatibleInput,
  type OpenAICompatibleMessage,
  type OpenAICompatibleState,
} from "./types";

const MAX_PROCESSED_INTERACTIONS = 256;

function sessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `llm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function initialState(saved?: OpenAICompatibleState, systemPrompt?: string): OpenAICompatibleState {
  if (saved?.schemaVersion === 1) {
    return {
      schemaVersion: 1,
      sessionId: saved.sessionId || sessionId(),
      turn: Number.isInteger(saved.turn) && saved.turn >= 0 ? saved.turn : 0,
      messages: Array.isArray(saved.messages) ? saved.messages : [],
      processedInteractionIds: Array.isArray(saved.processedInteractionIds)
        ? saved.processedInteractionIds.slice(-MAX_PROCESSED_INTERACTIONS)
        : [],
    };
  }
  const messages: OpenAICompatibleMessage[] = systemPrompt?.trim()
    ? [{ role: "system", content: systemPrompt.trim() }]
    : [];
  return { schemaVersion: 1, sessionId: sessionId(), turn: 0, messages, processedInteractionIds: [] };
}

export function llmInputInteraction(turn: number): ReaderInteraction {
  return {
    schemaVersion: 1,
    id: `llm:input:${turn}`,
    boundary: 0,
    kind: "text-input",
    editPolicy: "immutable",
    label: "What would you like to ask?",
    placeholder: "Write a message",
    prompt: "Send a message to the OpenAI-compatible assistant.",
    constraints: { required: true, maxLength: 16_000 },
    submitLabel: "Send",
    history: { kind: "value", prefix: "You asked", suffix: ".", quoteValue: true },
  };
}

export interface OpenAICompatibleFormatOptions {
  fetchImpl?: FetchLike;
  checkpointer?: LlmGraphDependencies["checkpointer"];
}

export class OpenAICompatibleFormat implements InteractiveFormat<OpenAICompatibleInput, OpenAICompatibleState> {
  readonly format = OPENAI_COMPATIBLE_FORMAT;
  readonly isDeterministic = false;
  private state: OpenAICompatibleState;
  private emit: ((chunk: StreamChunk<OpenAICompatibleState>) => void) | null = null;
  private disposed = false;
  private requestQueue = Promise.resolve();
  private streamWordCount = 0;
  private graph: ReturnType<typeof createLlmGraph> | null = null;

  constructor(private readonly options: OpenAICompatibleFormatOptions = {}) {
    this.state = initialState();
  }

  async init(input: OpenAICompatibleInput, savedState?: OpenAICompatibleState) {
    const connection = input?.connection;
    if (!connection?.baseUrl?.trim()) throw new Error("Enter an OpenAI-compatible endpoint before opening LLM Chat.");
    if (!connection.apiKey?.trim()) throw new Error("Enter an API key before opening LLM Chat.");
    const client = new OpenAICompatibleClient({ ...connection, baseUrl: normalizeOpenAIBaseUrl(connection.baseUrl), apiKey: connection.apiKey.trim() }, this.options.fetchImpl);
    this.graph = createLlmGraph({ client, checkpointer: this.options.checkpointer });
    this.state = initialState(savedState, connection.systemPrompt);
    return { initialState: this.getState(), title: "LLM Chat", author: "OpenAI-compatible endpoint" };
  }

  startStreaming(
    startIndex: number,
    onChunk: (chunk: StreamChunk<OpenAICompatibleState>) => void,
    _onError: (err: Error) => void,
  ): () => void {
    this.disposed = false;
    this.streamWordCount = startIndex;
    this.emit = onChunk;
    return () => {
      this.disposed = true;
      this.emit = null;
    };
  }

  async handleReaderEvent(event: ReaderEngineEvent): Promise<void> {
    if (event.kind !== "interaction-response" || event.response.kind !== "text-input") return;
    if (event.interactionId !== `llm:input:${this.state.turn}`) return;
    if (this.state.processedInteractionIds.includes(event.interactionId)) return;

    const userText = event.response.value;
    const run = async () => {
      if (!this.graph) throw new Error("The LLM graph has not been initialized.");
      const user: OpenAICompatibleMessage = { role: "user", content: userText };
      const result = await this.graph.invoke({
        messages: [...this.state.messages, user],
        lastAssistantText: "",
      }, { configurable: { thread_id: this.state.sessionId } });
      if (this.disposed || !this.emit) throw new Error("The LLM reader session was closed before the response completed.");

      const turn = this.state.turn;
      const turnId = `llm:turn:${turn}`;
      const words = formatAssistantText(result.lastAssistantText, turnId);
      if (words.length === 0) throw new Error("The assistant response contained no readable text.");
      this.state = {
        ...this.state,
        turn: turn + 1,
        messages: result.messages,
        processedInteractionIds: [...this.state.processedInteractionIds, event.interactionId]
          .slice(-MAX_PROCESSED_INTERACTIONS),
      };
      const nextInput = llmInputInteraction(this.state.turn);
      nextInput.boundary = words.length;
      const endIndex = this.streamWordCount + words.length - 1;
      this.emit({
        words,
        interactions: [nextInput],
        chapterUpdates: [{
          chapterId: LLM_CHAPTER_ID,
          title: "Conversation",
          startIndex: 0,
          endIndex,
        }],
        state: this.getState(),
        isComplete: false,
      });
      this.streamWordCount += words.length;
    };

    const current = this.requestQueue.then(run);
    this.requestQueue = current.catch(() => undefined);
    await current;
  }

  getState(): OpenAICompatibleState {
    return {
      ...this.state,
      messages: this.state.messages.map((message) => ({ ...message })),
      processedInteractionIds: [...this.state.processedInteractionIds],
    };
  }
}
