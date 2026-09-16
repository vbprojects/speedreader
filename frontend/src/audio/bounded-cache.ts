/** Byte/count-bounded LRU for native or processed audio. Use separate instances. */
export class BoundedCache<T> {
  private values = new Map<string, { value: T; bytes: number }>();
  private used = 0;
  constructor(readonly maxBytes: number, readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 0) {
      throw new Error("Invalid cache budget");
    }
  }
  get bytes(): number { return this.used; }
  get size(): number { return this.values.size; }
  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (entry) { this.values.delete(key); this.values.set(key, entry); }
    return entry?.value;
  }
  put(key: string, value: T, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid allocation size");
    this.delete(key);
    if (bytes > this.maxBytes || this.maxEntries === 0) return false;
    while (this.used + bytes > this.maxBytes || this.values.size >= this.maxEntries) {
      this.delete(this.values.keys().next().value!);
    }
    this.values.set(key, { value, bytes }); this.used += bytes;
    return true;
  }
  delete(key: string): void {
    const entry = this.values.get(key);
    if (entry) { this.used -= entry.bytes; this.values.delete(key); }
  }
  clear(): void { this.values.clear(); this.used = 0; }
}

/** Deliberately excludes DSP settings so compression changes reuse native PCM. */
export function nativeCacheKey(input: { model: string; runtime: string; voice: string; pacing: number; phonemeIds: readonly number[] }): string {
  return JSON.stringify([input.model, input.runtime, input.voice, input.pacing, input.phonemeIds]);
}
export function processedCacheKey(nativeKey: string, dspRevision: string, compression: number, sampleRate: number): string {
  return JSON.stringify([nativeKey, dspRevision, compression, sampleRate]);
}
