import { match } from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CredentialVault } from "../ingestion/openai-compatible";
import { LlmConnectionDialog } from "./LlmConnectionDialog";

const unusedVault: CredentialVault = {
  metadata: async () => null,
  save: async () => undefined,
  unlock: async () => { throw new Error("unused"); },
  delete: async () => undefined,
};

test("an imported model prefills the existing credential-safe LLM connection form", () => {
  const html = renderToStaticMarkup(createElement(LlmConnectionDialog, {
    open: true,
    theme: "light",
    vault: unusedVault,
    initialBaseUrl: "https://openrouter.ai/api/v1",
    initialModel: "openai/gpt-test",
    onConnect: () => undefined,
    onCancel: () => undefined,
  }));

  match(html, /value="https:\/\/openrouter\.ai\/api\/v1"/u);
  match(html, /value="openai\/gpt-test"/u);
  match(html, /API key/u);
  match(html, /The key stays in memory/u);
});
