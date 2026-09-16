export interface PreparationPolicy {
  readonly maxChunks: number;
  readonly maxBytes: number;
  shouldPrepare(readyChunks: number, readyBytes: number, bufferedSeconds: number): boolean;
}
export function preparationPolicy(mode: "prepared-chunk" | "lookahead", limits: {
  maxChunks?: number; maxBytes?: number; targetSeconds?: number;
} = {}): PreparationPolicy {
  const maxChunks = mode === "prepared-chunk" ? 1 : limits.maxChunks ?? 3;
  const maxBytes = limits.maxBytes ?? 24_000 * 4 * 90;
  const target = limits.targetSeconds ?? 20;
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      !Number.isFinite(target) || target <= 0) throw new Error("Invalid preparation limits");
  return { maxChunks, maxBytes, shouldPrepare(count, bytes, seconds) {
    return count < maxChunks && bytes < maxBytes && (mode === "prepared-chunk" || seconds < target);
  } };
}
