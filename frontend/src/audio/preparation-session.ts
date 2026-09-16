import { sameRevision, type AudioRevision } from "./protocol";

export interface Prepared<T> {
  revision: AudioRevision;
  value: T;
}

/**
 * Single-flight preparation boundary, usable with a fake or worker producer.
 * It never plays audio or advances words. A consumer must explicitly take ready
 * work, after rechecking interaction gates. Cancellation may be non-interruptible.
 */
export class PreparationSession<T> {
  private revision: AudioRevision;
  private generation = 0;
  private pending: AbortController | null = null;
  private ready: Prepared<T> | null = null;
  private disposed = false;
  private intent = false;
  private failure: unknown = null;

  constructor(revision: AudioRevision) { this.revision = { ...revision }; }

  get snapshot() {
    return { playIntent: this.intent, preparing: this.pending !== null,
      hasReady: this.ready !== null, error: this.failure, disposed: this.disposed };
  }

  play(): void { if (!this.disposed) this.intent = true; }
  pause(): void { this.intent = false; }

  /** Seek/book/content/settings transitions invalidate even uncancellable work. */
  invalidate(revision: AudioRevision, keepPlayIntent = false): void {
    if (this.disposed) return;
    this.generation++;
    this.revision = { ...revision };
    this.pending?.abort();
    this.ready = null;
    this.failure = null;
    if (!keepPlayIntent) this.intent = false;
  }

  async prepare(produce: (revision: AudioRevision, signal: AbortSignal) => Promise<Prepared<T>>): Promise<void> {
    if (this.disposed) throw new Error("Preparation session is disposed");
    if (this.pending) throw new Error("Inference is still running");
    if (this.ready) throw new Error("Consume or invalidate the prepared result first");
    const controller = new AbortController();
    const revision = { ...this.revision };
    const generation = this.generation;
    this.pending = controller;
    this.failure = null;
    try {
      const result = await produce({ ...revision }, controller.signal);
      if (this.disposed || generation !== this.generation) return;
      if (!sameRevision(result.revision, revision)) {
        throw new Error("Producer returned a mismatched revision");
      }
      this.ready = { revision, value: result.value };
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.failure = error;
    } finally {
      this.pending = null;
    }
  }

  takeReady(canSchedule: () => boolean): Prepared<T> | null {
    if (this.disposed || !this.intent || !this.ready || !canSchedule()) return null;
    const result = this.ready;
    this.ready = null;
    return result;
  }

  dispose(): void {
    this.invalidate(this.revision);
    this.disposed = true;
  }
}
