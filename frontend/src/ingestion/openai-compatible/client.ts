import type { OpenAICompatibleConnection, OpenAICompatibleMessage } from "./types";

export type FetchLike = typeof fetch;

export function normalizeOpenAIBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid endpoint URL.");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("Remote endpoints must use HTTPS; HTTP is allowed only for a loopback endpoint.");
  }
  // Provider documentation commonly publishes the complete chat-completions
  // URL. Accept that form as well as a base URL so callers do not accidentally
  // request .../chat/completions/chat/completions.
  parsed.pathname = parsed.pathname
    .replace(/\/(?:chat\/completions|models)\/?$/u, "")
    .replace(/\/+$/u, "");
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

interface ModelsResponse {
  data?: Array<{ id?: unknown }>;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
}

function endpoint(baseUrl: string, path: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
  parsed.hash = "";
  return parsed.toString();
}

function isOpenRouter(baseUrl: string): boolean {
  return new URL(baseUrl).hostname.toLowerCase() === "openrouter.ai";
}

function networkError(url: string, error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") return error;
  const cause = error instanceof Error ? error.message : String(error);
  return new Error(
    `Could not connect to ${new URL(url).origin}. Check the endpoint, network connection, and browser CORS access. (${cause})`,
  );
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: unknown } | string };
    if (typeof body.error === "string") return body.error;
    if (typeof body.error?.message === "string") return body.error.message;
  } catch {
    // The status below is still useful when the endpoint returns non-JSON.
  }
  return `${response.status} ${response.statusText}`.trim();
}

export class OpenAICompatibleClient {
  private resolvedModel: string | null = null;

  constructor(
    private readonly connection: OpenAICompatibleConnection,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private headers(): HeadersInit {
    return {
      "Content-Type": "application/json",
      ...(this.connection.apiKey ? { Authorization: `Bearer ${this.connection.apiKey}` } : {}),
      ...this.connection.headers,
    };
  }

  private async model(): Promise<string | undefined> {
    if (this.connection.model?.trim()) return this.connection.model.trim();
    // OpenRouter supports an omitted model and then uses the payer/account
    // default. Discovering and selecting the first item in its global catalog
    // is both surprising and potentially expensive.
    if (isOpenRouter(this.connection.baseUrl)) return undefined;
    if (this.resolvedModel) return this.resolvedModel;
    const modelsUrl = endpoint(this.connection.baseUrl, "models");
    let response: Response;
    try {
      response = await this.fetchImpl(modelsUrl, { headers: this.headers() });
    } catch (error) {
      throw networkError(modelsUrl, error);
    }
    if (!response.ok) {
      throw new Error(`Unable to discover an OpenAI-compatible model: ${await errorMessage(response)}`);
    }
    const body = await response.json() as ModelsResponse;
    const model = body.data?.find((candidate) => typeof candidate.id === "string")?.id;
    if (typeof model !== "string" || !model.trim()) {
      throw new Error("The OpenAI-compatible endpoint returned no models; enter a model ID when connecting.");
    }
    this.resolvedModel = model;
    return model;
  }

  async complete(messages: OpenAICompatibleMessage[], signal?: AbortSignal): Promise<OpenAICompatibleMessage> {
    const model = await this.model();
    const completionsUrl = endpoint(this.connection.baseUrl, "chat/completions");
    let response: Response;
    try {
      response = await this.fetchImpl(completionsUrl, {
        method: "POST",
        headers: this.headers(),
        signal,
        body: JSON.stringify({
          ...(model ? { model } : {}),
          messages,
          stream: false,
        }),
      });
    } catch (error) {
      throw networkError(completionsUrl, error);
    }
    if (!response.ok) {
      throw new Error(`OpenAI-compatible completion failed: ${await errorMessage(response)}`);
    }
    const body = await response.json() as ChatCompletionResponse;
    const message = body.choices?.[0]?.message;
    if (!message || typeof message.content !== "string" || !message.content.trim()) {
      throw new Error("The OpenAI-compatible endpoint returned no textual assistant response.");
    }
    return {
      role: "assistant",
      content: message.content,
      ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
    };
  }
}
