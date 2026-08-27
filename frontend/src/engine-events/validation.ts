import type { EngineTrigger } from "./types";

export function validateEngineTriggers(triggers: EngineTrigger[] = [], totalWords: number): EngineTrigger[] {
  const ids = new Set<string>();
  return triggers.map((trigger) => {
    if (trigger.schemaVersion !== 1 || trigger.kind !== "engine-trigger") throw new Error("unsupported engine trigger");
    if (!trigger.id.trim()) throw new Error("engine trigger id is required");
    if (ids.has(trigger.id)) throw new Error("duplicate engine trigger id: " + trigger.id);
    ids.add(trigger.id);
    if (!Number.isInteger(trigger.boundary) || trigger.boundary < 0 || trigger.boundary > totalWords) {
      throw new Error("engine trigger boundary is outside the word stream: " + trigger.id);
    }
    if (!trigger.signal.type.trim()) throw new Error("engine trigger signal type is required: " + trigger.id);
    return { ...trigger, signal: { ...trigger.signal, ...(trigger.signal.payload ? { payload: { ...trigger.signal.payload } } : {}) } };
  });
}
