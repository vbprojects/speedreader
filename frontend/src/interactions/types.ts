// Shared, JSON-serializable interaction contracts.
//
// Ingestion engines emit these descriptors alongside a WordStream. The reader
// renders them without executing source HTML or depending on a specific story
// runtime. A boundary is a count of consumed words: 0 is before the first word
// and N is immediately after word N - 1.

export const INTERACTION_SCHEMA_VERSION = 1 as const;

export interface InteractionConstraints {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
}

export interface InteractionBase {
  schemaVersion: typeof INTERACTION_SCHEMA_VERSION;
  id: string;
  /** Number of words consumed before this interaction is shown. */
  boundary: number;
  prompt?: string;
  sourceRef?: string;
}

export interface TextInputInteraction extends InteractionBase {
  kind: "text-input";
  label: string;
  placeholder?: string;
  defaultValue?: string;
  constraints?: InteractionConstraints;
  submitLabel?: string;
}

export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface ChoiceInteraction extends InteractionBase {
  kind: "single-choice";
  options: ChoiceOption[];
  submitLabel?: string;
}

export interface ContinueInteraction extends InteractionBase {
  kind: "continue";
  label?: string;
  description?: string;
}

export type ReaderInteraction =
  | TextInputInteraction
  | ChoiceInteraction
  | ContinueInteraction;

export interface TextInputResponse {
  schemaVersion: typeof INTERACTION_SCHEMA_VERSION;
  interactionId: string;
  kind: "text-input";
  value: string;
}

export interface ChoiceResponse {
  schemaVersion: typeof INTERACTION_SCHEMA_VERSION;
  interactionId: string;
  kind: "single-choice";
  optionId: string;
}

export interface ContinueResponse {
  schemaVersion: typeof INTERACTION_SCHEMA_VERSION;
  interactionId: string;
  kind: "continue";
}

export type InteractionResponse =
  | TextInputResponse
  | ChoiceResponse
  | ContinueResponse;
