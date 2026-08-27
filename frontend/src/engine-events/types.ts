import type { InteractionResponse } from "../interactions/types";

export interface EngineTrigger {
  schemaVersion: 1;
  id: string;
  /** Number of words consumed before this trigger fires. */
  boundary: number;
  kind: "engine-trigger";
  signal: { type: string; payload?: Record<string, unknown> };
  delivery?: "once" | "repeat";
  direction?: "forward";
}

export type ReaderEngineEvent =
  | {
      schemaVersion: 1;
      eventId: string;
      kind: "trigger";
      triggerId: string;
      signal: EngineTrigger["signal"];
      boundary: number;
      position: number;
    }
  | {
      schemaVersion: 1;
      eventId: string;
      kind: "interaction-response";
      interactionId: string;
      response: InteractionResponse;
      boundary: number;
      position: number;
    };
