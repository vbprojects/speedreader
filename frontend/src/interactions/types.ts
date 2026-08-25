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
  /** Whether a completed action may be edited from native reading. */
  editPolicy?: "immutable" | "mutable";
}

export interface ValueHistoryPresentation {
  kind: "value";
  prefix: string;
  suffix?: string;
  quoteValue?: boolean;
}

export interface StatementHistoryPresentation {
  kind: "statement";
  text: string;
}

export interface TextInputInteraction extends InteractionBase {
  kind: "text-input";
  label: string;
  placeholder?: string;
  defaultValue?: string;
  constraints?: InteractionConstraints;
  submitLabel?: string;
  history?: ValueHistoryPresentation;
}

export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  /** Complete past-tense sentence shown after this option is selected. */
  resolvedText?: string;
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
  history?: StatementHistoryPresentation;
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

/** The persisted answer for the interaction node at a stream boundary. */
export interface InteractionRecord {
  schemaVersion: typeof INTERACTION_SCHEMA_VERSION;
  interactionId: string;
  response: InteractionResponse;
  answeredAt: number;
  updatedAt: number;
  revision: number;
}
