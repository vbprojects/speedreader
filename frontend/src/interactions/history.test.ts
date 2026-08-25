import { equal } from "node:assert/strict";
import { test } from "node:test";
import { formatResolvedInteraction } from "./history";
import type { InteractionRecord, ReaderInteraction } from "./types";

const record = (response: InteractionRecord["response"]): InteractionRecord => ({
  schemaVersion: 1, interactionId: response.interactionId, response,
  answeredAt: 1, updatedAt: 1, revision: 1,
});

test("history renders a text answer as a past-tense value", () => {
    const interaction: ReaderInteraction = {
      schemaVersion: 1, id: "name", boundary: 1, kind: "text-input", label: "Name",
      history: { kind: "value", prefix: "You introduced yourself as", suffix: "." },
    };
    equal(formatResolvedInteraction(interaction, record({ schemaVersion: 1, interactionId: "name", kind: "text-input", value: "Ada" })), "You introduced yourself as “Ada”.");
});

test("history uses authored choice and continue statements", () => {
    const choice: ReaderInteraction = {
      schemaVersion: 1, id: "path", boundary: 1, kind: "single-choice",
      options: [{ id: "garden", label: "Garden", resolvedText: "You entered the garden" }],
    };
    const cont: ReaderInteraction = {
      schemaVersion: 1, id: "done", boundary: 1, kind: "continue", history: { kind: "statement", text: "You continued" },
    };
    equal(formatResolvedInteraction(choice, record({ schemaVersion: 1, interactionId: "path", kind: "single-choice", optionId: "garden" })), "You entered the garden.");
    equal(formatResolvedInteraction(cont, record({ schemaVersion: 1, interactionId: "done", kind: "continue" })), "You continued.");
});
