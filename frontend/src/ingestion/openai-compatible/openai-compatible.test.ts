import { deepStrictEqual, equal, match, rejects, throws } from "node:assert/strict";
import { test } from "node:test";
import type { ReaderEngineEvent } from "../../engine-events/types";
import { normalizeOpenAIBaseUrl, OpenAICompatibleClient } from "./client";
import { createSessionId, OpenAICompatibleFormat } from "./format";

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

test("endpoint validation permits HTTPS and loopback HTTP only", () => {
  equal(normalizeOpenAIBaseUrl("https://provider.example/v1/"), "https://provider.example/v1");
  equal(normalizeOpenAIBaseUrl("http://localhost:11434/v1"), "http://localhost:11434/v1");
  equal(normalizeOpenAIBaseUrl("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1");
  throws(() => normalizeOpenAIBaseUrl("http://provider.example/v1"), /must use HTTPS/);
  throws(() => normalizeOpenAIBaseUrl("file:///tmp/model"), /must use HTTPS/);
});

test("endpoint normalization accepts complete OpenRouter resource URLs", () => {
  equal(
    normalizeOpenAIBaseUrl("https://openrouter.ai/api/v1/chat/completions"),
    "https://openrouter.ai/api/v1",
  );
  equal(
    normalizeOpenAIBaseUrl("https://openrouter.ai/api/v1/models/"),
    "https://openrouter.ai/api/v1",
  );
});

test("session IDs use cryptographic bytes when randomUUID is unavailable", () => {
  const id = createSessionId({
    getRandomValues(array) {
      const bytes = array as Uint8Array;
      for (let index = 0; index < bytes.length; index++) bytes[index] = index;
      return array;
    },
  });
  equal(id, "00010203-0405-4607-8809-0a0b0c0d0e0f");
});

test("client discovers a model and sends an OpenAI-compatible chat completion", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/models")) return json({ data: [{ id: "local-model" }] });
    return json({ choices: [{ message: { content: "Hello from the model." } }] });
  };
  const client = new OpenAICompatibleClient({ baseUrl: "http://localhost:11434/v1/" }, fetchImpl);
  const result = await client.complete([{ role: "user", content: "Hello" }]);

  equal(result.content, "Hello from the model.");
  equal(requests[0].url, "http://localhost:11434/v1/models");
  equal(requests[1].url, "http://localhost:11434/v1/chat/completions");
  equal((requests[1].init?.headers as Record<string, string>).Authorization, undefined);
  deepStrictEqual(JSON.parse(String(requests[1].init?.body)), {
    model: "local-model",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
  });
});

test("client sends the user-provided key without putting it in the request body", async () => {
  let request: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    request = init;
    return json({ choices: [{ message: { content: "Safe response" } }] });
  };
  await new OpenAICompatibleClient({ baseUrl: "https://example.test/v1", apiKey: "user-key", model: "model" }, fetchImpl)
    .complete([{ role: "user", content: "Hello" }]);
  equal((request?.headers as Record<string, string>).Authorization, "Bearer user-key");
  equal(String(request?.body).includes("user-key"), false);
});

test("client keeps the browser global as the fetch receiver", async () => {
  const receiverCheckingFetch = function (this: unknown) {
    equal(this, globalThis);
    return Promise.resolve(json({ choices: [{ message: { content: "Receiver preserved" } }] }));
  } as typeof fetch;
  const result = await new OpenAICompatibleClient({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "user-key",
    model: "openai/gpt-test",
  }, receiverCheckingFetch).complete([{ role: "user", content: "Hello" }]);

  equal(result.content, "Receiver preserved");
});

test("OpenRouter uses its configured default without catalog discovery", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return json({ choices: [{ message: { content: "Default route response" } }] });
  };
  const baseUrl = normalizeOpenAIBaseUrl("https://openrouter.ai/api/v1/chat/completions");
  await new OpenAICompatibleClient({ baseUrl, apiKey: "user-key" }, fetchImpl)
    .complete([{ role: "user", content: "Hello" }]);

  equal(requests.length, 1);
  equal(requests[0].url, "https://openrouter.ai/api/v1/chat/completions");
  equal("model" in JSON.parse(String(requests[0].init?.body)), false);
});

test("client turns opaque fetch failures into actionable connection errors", async () => {
  const failing: typeof fetch = async () => { throw new TypeError("Failed to fetch"); };
  await rejects(
    () => new OpenAICompatibleClient({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "user-key",
      model: "openai/gpt-5.2",
    }, failing).complete([{ role: "user", content: "Hello" }]),
    /Could not connect to https:\/\/openrouter\.ai.*browser CORS access.*Failed to fetch/,
  );
});

test("client reports compatible endpoint errors without accepting empty responses", async () => {
  const failing: typeof fetch = async () => json({ error: { message: "model unavailable" } }, { status: 503 });
  const client = new OpenAICompatibleClient({ baseUrl: "https://example.test/v1", model: "test" }, failing);
  await rejects(() => client.complete([{ role: "user", content: "Hello" }]), /model unavailable/);

  const empty: typeof fetch = async () => json({ choices: [{ message: { content: "" } }] });
  await rejects(
    () => new OpenAICompatibleClient({ baseUrl: "https://example.test/v1", model: "test" }, empty)
      .complete([{ role: "user", content: "Hello" }]),
    /no textual assistant response/,
  );
});

test("LangGraph format turns a text action into words and the next inline action", async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    equal(body.messages[body.messages.length - 1]?.content, "Explain particle filters");
    return json({ choices: [{ message: { content: "Particles approximate a changing posterior." } }] });
  };
  const format = new OpenAICompatibleFormat({ fetchImpl });
  const initialized = await format.init({ connection: { baseUrl: "https://example.test/v1", apiKey: "secret", model: "test-model" } });
  match(initialized.initialState.sessionId, /.+/);
  const chunks: Parameters<Parameters<typeof format.startStreaming>[1]>[0][] = [];
  format.startStreaming(10, (chunk) => chunks.push(chunk), (error) => { throw error; });
  const event: ReaderEngineEvent = {
    schemaVersion: 1,
    eventId: "event-1",
    kind: "interaction-response",
    interactionId: "llm:input:0",
    response: { schemaVersion: 1, interactionId: "llm:input:0", kind: "text-input", value: "Explain particle filters" },
    boundary: 10,
    position: 9,
  };
  await format.handleReaderEvent(event);

  equal(chunks.length, 1);
  equal(chunks[0].words.map((word) => word.text).join(" "), "Particles approximate a changing posterior.");
  equal(chunks[0].interactions?.[0].id, "llm:input:1");
  equal(chunks[0].interactions?.[0].boundary, chunks[0].words.length);
  equal(chunks[0].chapterUpdates?.[0].endIndex, 14);
  equal(chunks[0].isComplete, false);
  equal(chunks[0].state.turn, 1);
  deepStrictEqual(chunks[0].state.messages.map((message) => message.role), ["user", "assistant"]);

  await format.handleReaderEvent(event);
  equal(chunks.length, 1, "replayed durable events must not duplicate a turn");
});

test("one LLM action joins concurrent deliveries into one provider request", async () => {
  let requestCount = 0;
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
  const format = new OpenAICompatibleFormat({
    fetchImpl: async () => {
      requestCount += 1;
      return response;
    },
  });
  await format.init({ connection: { baseUrl: "https://example.test/v1", apiKey: "secret", model: "test-model" } });
  const chunks: unknown[] = [];
  format.startStreaming(0, (chunk) => chunks.push(chunk), () => undefined);
  const event: ReaderEngineEvent = {
    schemaVersion: 1,
    eventId: "interaction-response:llm:input:0",
    kind: "interaction-response",
    interactionId: "llm:input:0",
    response: { schemaVersion: 1, interactionId: "llm:input:0", kind: "text-input", value: "Only once" },
    boundary: 0,
    position: 0,
  };

  const first = format.handleReaderEvent(event);
  const replay = format.handleReaderEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(requestCount, 1);
  resolveResponse(json({ choices: [{ message: { content: "One response" } }] }));
  await Promise.all([first, replay]);

  equal(requestCount, 1);
  equal(chunks.length, 1);
});

test("failed model calls leave the input action unresolved and retryable", async () => {
  const fetchImpl: typeof fetch = async () => json({ error: { message: "offline" } }, { status: 503 });
  const format = new OpenAICompatibleFormat({ fetchImpl });
  await format.init({ connection: { baseUrl: "https://example.test/v1", apiKey: "secret", model: "test-model" } });
  const chunks: unknown[] = [];
  format.startStreaming(0, (chunk) => chunks.push(chunk), () => undefined);
  const event: ReaderEngineEvent = {
    schemaVersion: 1,
    eventId: "event-1",
    kind: "interaction-response",
    interactionId: "llm:input:0",
    response: { schemaVersion: 1, interactionId: "llm:input:0", kind: "text-input", value: "Hello" },
    boundary: 0,
    position: 0,
  };
  await rejects(() => format.handleReaderEvent(event), /offline/);
  equal(chunks.length, 0);
  equal(format.getState().turn, 0);
});

test("format requires user-supplied endpoint credentials and never stores them in state", async () => {
  const format = new OpenAICompatibleFormat({ fetchImpl: async () => json({}) });
  await rejects(() => format.init({ connection: { baseUrl: "", apiKey: "secret" } }), /endpoint/);
  await rejects(() => format.init({ connection: { baseUrl: "https://example.test/v1" } }), /API key/);
  await format.init({ connection: { baseUrl: "https://example.test/v1", apiKey: "top-secret", model: "model" } });
  const serialized = JSON.stringify(format.getState());
  equal(serialized.includes("top-secret"), false);
  equal(serialized.includes("example.test"), false);
});
