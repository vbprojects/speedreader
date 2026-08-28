export const OPENAI_COMPATIBLE_FORMAT = "openai-compatible-llm";

export interface OpenAICompatibleMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

/** Runtime connection details. Credentials are deliberately not persisted. */
export interface OpenAICompatibleConnection {
  baseUrl: string;
  model?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  systemPrompt?: string;
}

export interface OpenAICompatibleInput {
  connection: OpenAICompatibleConnection;
}

export interface OpenAICompatibleState extends Record<string, unknown> {
  schemaVersion: 1;
  sessionId: string;
  turn: number;
  messages: OpenAICompatibleMessage[];
  processedInteractionIds: string[];
}
