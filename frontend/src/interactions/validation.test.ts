import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import { test } from "node:test";
import { validateInteraction, validateInteractionRecord, validateInteractionResponse, validateInteractions } from "./validation";

test("interaction descriptors survive JSON round trips", () => {
  const source = {
    schemaVersion: 1,
    id: "name",
    boundary: 3,
    kind: "text-input",
    label: "Your name",
    constraints: { required: true, maxLength: 40 },
  } as const;
  const parsed = JSON.parse(JSON.stringify(source)) as unknown;
  deepStrictEqual(validateInteraction(parsed, 3), source);
});

test("validation rejects malformed boundaries and duplicate ids", () => {
  throws(() => validateInteraction({ schemaVersion: 1, id: "bad", boundary: -1, kind: "continue" }));
  throws(() => validateInteraction({ schemaVersion: 1, id: "bad", boundary: 4, kind: "continue" }, 3));
  throws(() => validateInteractions([
    { schemaVersion: 1, id: "same", boundary: 0, kind: "continue" },
    { schemaVersion: 1, id: "same", boundary: 1, kind: "continue" },
  ], 1));
});

test("responses are validated independently of the UI", () => {
  const response = validateInteractionResponse({
    schemaVersion: 1,
    interactionId: "choice",
    kind: "single-choice",
    optionId: "yes",
  });
  equal(response.kind, "single-choice");
  rejects(async () => validateInteractionResponse({ schemaVersion: 1, interactionId: "", kind: "continue" }));
});

test("records must match the descriptor and preserve mutable revisions", () => {
  const interaction = validateInteraction({ schemaVersion: 1, id: "name", boundary: 0, kind: "text-input", label: "Name", editPolicy: "mutable" });
  const record = validateInteractionRecord({
    schemaVersion: 1, interactionId: "name", response: { schemaVersion: 1, interactionId: "name", kind: "text-input", value: "Ada" },
    answeredAt: 10, updatedAt: 20, revision: 2,
  }, interaction);
  equal(record.revision, 2);
  throws(() => validateInteractionRecord({ ...record, response: { schemaVersion: 1, interactionId: "other", kind: "text-input", value: "x" } }, interaction));
});
