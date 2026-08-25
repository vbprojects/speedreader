import {
  INTERACTION_SCHEMA_VERSION,
  type ChoiceInteraction,
  type ChoiceOption,
  type InteractionConstraints,
  type InteractionResponse,
  type ReaderInteraction,
} from "./types";

export class InteractionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InteractionValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InteractionValidationError(field + " must be a non-empty string");
  }
  return value;
}

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new InteractionValidationError(field + " must be a string when provided");
  }
}

function optionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new InteractionValidationError(field + " must be a boolean when provided");
  }
}

function validateConstraints(value: unknown): InteractionConstraints | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new InteractionValidationError("constraints must be an object");
  }
  for (const field of ["required"] as const) optionalBoolean(value[field], "constraints." + field);
  for (const field of ["minLength", "maxLength"] as const) {
    if (value[field] !== undefined && (!Number.isInteger(value[field]) || (value[field] as number) < 0)) {
      throw new InteractionValidationError("constraints." + field + " must be a non-negative integer");
    }
  }
  if (
    value.minLength !== undefined &&
    value.maxLength !== undefined &&
    (value.minLength as number) > (value.maxLength as number)
  ) {
    throw new InteractionValidationError("constraints.minLength cannot exceed maxLength");
  }
  return value as InteractionConstraints;
}

function validateChoiceOptions(value: unknown): ChoiceOption[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InteractionValidationError("single-choice interactions need at least one option");
  }
  const ids = new Set<string>();
  return value.map((option, index) => {
    if (!isRecord(option)) {
      throw new InteractionValidationError("options[" + index + "] must be an object");
    }
    const id = requireString(option.id, "options[" + index + "].id");
    if (ids.has(id)) throw new InteractionValidationError("duplicate choice option id: " + id);
    ids.add(id);
    optionalString(option.description, "options[" + index + "].description");
    optionalBoolean(option.disabled, "options[" + index + "].disabled");
    return option as ChoiceOption;
  });
}

export function validateInteraction(
  value: unknown,
  boundaryLimit?: number
): ReaderInteraction {
  if (!isRecord(value)) throw new InteractionValidationError("interaction must be an object");
  if (value.schemaVersion !== INTERACTION_SCHEMA_VERSION) {
    throw new InteractionValidationError("unsupported interaction schemaVersion");
  }
  const id = requireString(value.id, "id");
  if (!Number.isInteger(value.boundary) || (value.boundary as number) < 0) {
    throw new InteractionValidationError("boundary must be a non-negative integer");
  }
  if (boundaryLimit !== undefined && (value.boundary as number) > boundaryLimit) {
    throw new InteractionValidationError("boundary must be <= " + boundaryLimit);
  }
  optionalString(value.prompt, "prompt");
  optionalString(value.sourceRef, "sourceRef");

  switch (value.kind) {
    case "text-input":
      requireString(value.label, "label");
      optionalString(value.placeholder, "placeholder");
      optionalString(value.defaultValue, "defaultValue");
      optionalString(value.submitLabel, "submitLabel");
      validateConstraints(value.constraints);
      return value as ReaderInteraction;
    case "single-choice":
      validateChoiceOptions(value.options);
      optionalString(value.submitLabel, "submitLabel");
      return value as ChoiceInteraction;
    case "continue":
      optionalString(value.label, "label");
      optionalString(value.description, "description");
      return value as ReaderInteraction;
    default:
      throw new InteractionValidationError("unsupported interaction kind: " + String(value.kind));
  }
}

export function validateInteractions(
  value: unknown,
  boundaryLimit?: number
): ReaderInteraction[] {
  if (!Array.isArray(value)) {
    throw new InteractionValidationError("interactions must be an array");
  }
  const ids = new Set<string>();
  return value.map((item) => {
    const interaction = validateInteraction(item, boundaryLimit);
    if (ids.has(interaction.id)) {
      throw new InteractionValidationError("duplicate interaction id: " + interaction.id);
    }
    ids.add(interaction.id);
    return interaction;
  });
}

export function validateInteractionResponse(value: unknown): InteractionResponse {
  if (!isRecord(value)) throw new InteractionValidationError("interaction response must be an object");
  if (value.schemaVersion !== INTERACTION_SCHEMA_VERSION) {
    throw new InteractionValidationError("unsupported interaction response schemaVersion");
  }
  const interactionId = requireString(value.interactionId, "interactionId");
  switch (value.kind) {
    case "text-input":
      if (typeof value.value !== "string") {
        throw new InteractionValidationError("text-input response value must be a string");
      }
      return value as InteractionResponse;
    case "single-choice":
      return {
        schemaVersion: INTERACTION_SCHEMA_VERSION,
        interactionId,
        kind: "single-choice",
        optionId: requireString(value.optionId, "optionId"),
      };
    case "continue":
      return { schemaVersion: INTERACTION_SCHEMA_VERSION, interactionId, kind: "continue" };
    default:
      throw new InteractionValidationError("unsupported response kind: " + String(value.kind));
  }
}
