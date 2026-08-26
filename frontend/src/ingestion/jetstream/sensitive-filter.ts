import type { JetstreamPostEvent } from "./types";

export const SENSITIVE_SELF_LABELS = new Set(["porn", "sexual", "nudity", "graphic-media"]);

/** Conservative, self-label-only filter. Jetstream does not carry moderator labels. */
export function hasSensitiveSelfLabel(event: JetstreamPostEvent): boolean {
  const labels = event.commit.record.labels;
  if (labels === undefined) return false;
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return true;
  const values = (labels as Record<string, unknown>).values;
  if (!Array.isArray(values)) return true;
  for (const item of values) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return true;
    const value = (item as Record<string, unknown>).val;
    if (typeof value !== "string") return true;
    if (SENSITIVE_SELF_LABELS.has(value.toLowerCase())) return true;
  }
  return false;
}
