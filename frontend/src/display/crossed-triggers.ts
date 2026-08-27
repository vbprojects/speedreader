import type { WordStream } from "../epub/types";
import type { EngineTrigger } from "../engine-events/types";

/** Select forward-only triggers crossed between two consumed-word boundaries. */
export function crossedEngineTriggers(
  stream: WordStream,
  fromBoundary: number,
  toBoundary: number,
  deliveredIds: ReadonlySet<string>,
): EngineTrigger[] {
  if (toBoundary < fromBoundary) return [];
  return (stream.triggers ?? []).filter((trigger) =>
    trigger.boundary > fromBoundary &&
    trigger.boundary <= toBoundary &&
    (trigger.delivery === "repeat" || !deliveredIds.has(trigger.id))
  );
}
