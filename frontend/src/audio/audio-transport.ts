import { normalizeSpeechText } from "./speech-text";
import type { Word } from "../epub/types";
import type { PlaybackTransport } from "../display/types";
import { AudioOutput, resampleAudio } from "./audio-output";
import type { SpeechProducer, PreparedSpeech } from "./kokoro-engine";
import type { AudioSettings } from "./settings";
import { ObservedSpeechRate } from "./observed-rate";
import { preparationPolicy, type PreparationPolicy } from "./preparation-policy";
import { sameRevision, type AudioRevision } from "./protocol";
export type AudioState = "paused" | "preparing" | "playing" | "buffering" | "waiting-for-interaction" | "ended" | "error";
export interface AudioSink {
  sampleRate: number;
  play(): Promise<void>;
  pause(): void;
  reset(): void;
  enqueue(pcm: Float32Array): void;
  dispose(): Promise<void>;
}
export interface AudioSnapshot {
  state: AudioState;
  error?: string;
  index: number;
  playIntent: boolean;
  consumedSamples: number;
  bufferedSeconds: number;
  readyChunks: number;
  readyBytes: number;
  preparing: boolean;
  disposed: boolean;
  revision: AudioRevision;
}
export interface AudioMeasurements {
  /** Wall time between chunks; excludes silence inside generated PCM. */
  lastChunkWaitMilliseconds?: number;
  provider: string;
  initializationMilliseconds: number;
  synthesisMilliseconds: number;
  preparedSeconds: number;
  bufferedSeconds: number;
  nativeCacheHit: boolean;
  preparationMilliseconds: number;
  phonemizationMilliseconds: number;
  dspMilliseconds: number;
}
export interface AudioTransportOptions {
  onMeasurements?(measurements: AudioMeasurements): void;
  onObservedWpm?(wpm: number | null): void;
  policy?: PreparationPolicy;
  outputFactory?: (onCursor: (cursor: { sample: number; remaining: number; underrun: boolean }) => void,
    onError: (error: Error) => void) => AudioSink;
  words(): readonly Word[];
  complete(): boolean;
  settings(): AudioSettings;
  allowedEnd(start: number): number;
  engine(): Promise<SpeechProducer>;
  canStart(index: number): boolean;
  canAdvance(from: number, to: number): boolean;
  onBlocked(index: number): void;
  onTick(index: number): void;
  onEnd(): void;
  onStatus(state: AudioState, error?: string): void;
}
/** One playing chunk and one prepared chunk; a replaceable policy boundary.
 * `running` is user intent, so buffering does not pause an append-only source.
 */
export class AudioTransport implements PlaybackTransport {
  private position = 0;
  private phase: AudioState = "paused";
  private error: string | undefined;
  private consumedSamples = 0;
  private remainingSamples = 0;
  private listeners = new Set<(snapshot: AudioSnapshot) => void>();
  private intent = false;
  private disposed = false;
  private generation = 0;
  private pending = false;
  private ready: PreparedSpeech[] = [];
  private policy: PreparationPolicy;
  private active: PreparedSpeech | null = null;
  private activeSamples = 0;
  private scheduling = false;
  private chunkWaitStarted: number | null = null;
  private lastChunkWaitMilliseconds = 0;
  private lastMeasurements: AudioMeasurements | null = null;
  private next = 0;
  private observed = new ObservedSpeechRate();
  private observedChunkSamples = 0;
  private observedChunkWords = 0;
  private observedSettings = "";
  private output: AudioSink;
  private revision: AudioRevision = { sessionId: crypto.randomUUID(), contentRevision: 0, synthesisRevision: 0, dspRevision: 0 };
  constructor(private options: AudioTransportOptions) {
    this.policy = options.policy ?? preparationPolicy("lookahead", { maxChunks: 2 });
    const createOutput = options.outputFactory ?? ((cursor, error) => new AudioOutput(cursor, error));
    this.output = createOutput(cursor => {
      this.consumedSamples = cursor.sample; this.remainingSamples = cursor.remaining;
      if (!this.intent || !this.active) { this.publish(); return; }
      try {
        const completed = this.active.words.filter(word => word.endSample > word.startSample && word.endSample <= cursor.sample).length;
        const wpm = this.observed.add(Math.max(0, cursor.sample - this.observedChunkSamples),
          Math.max(0, completed - this.observedChunkWords), this.output.sampleRate);
        if (completed !== this.observedChunkWords || cursor.remaining === 0) this.options.onObservedWpm?.(wpm);
        this.observedChunkSamples = cursor.sample; this.observedChunkWords = completed;
        for (const word of this.active.words) {
          if (word.startSample > cursor.sample) break;
          if (word.wordIndex > this.position) {
            if (!this.advance(word.wordIndex)) return;
          }
        }
        if (cursor.remaining === 0 && cursor.sample >= this.activeSamples) {
          const end = this.active.endWordExclusive;
          this.active = null;
          this.next = end;
          if (!this.advance(end)) return;
          if (end >= this.options.words().length && this.options.complete()) {
            this.intent = false; this.output.pause(); this.status("ended"); this.options.onEnd(); return;
          }
          this.chunkWaitStarted = performance.now();
          this.status("buffering"); void this.pump();
        }
      } finally { this.publish(); }
    }, error => this.fail(error));
  }
  get index(): number { return this.position; }
  get running(): boolean { return this.intent; }
  get snapshot(): AudioSnapshot {
    return { state: this.phase, error: this.error, index: this.position, playIntent: this.intent,
      consumedSamples: this.consumedSamples,
      bufferedSeconds: (this.output.sampleRate ? this.remainingSamples / this.output.sampleRate : 0) +
        this.ready.reduce((seconds, chunk) => seconds + chunk.pcm.length / chunk.sampleRate, 0),
      readyChunks: this.ready.length, readyBytes: this.ready.reduce((bytes, chunk) => bytes + chunk.pcm.byteLength, 0),
      preparing: this.pending, disposed: this.disposed, revision: { ...this.revision } };
  }
  subscribe(listener: (snapshot: AudioSnapshot) => void): () => void {
    this.listeners.add(listener); listener(this.snapshot);
    return () => { this.listeners.delete(listener); };
  }
  private publish(): void { if (this.listeners.size) { const snapshot = this.snapshot; this.listeners.forEach(listener => listener(snapshot)); } }
  private status(state: AudioState, error?: string) {
    this.phase = state; this.error = error; this.publish();
    if (!this.disposed) this.options.onStatus(state, error);
  }
  private advance(index: number): boolean {
    for (let next = this.position + 1; next <= index; next++) {
      if (!this.options.canAdvance(next - 1, next)) {
        this.intent = false; this.output.pause(); this.ready = [];
        this.next = next; this.status("waiting-for-interaction"); this.options.onBlocked(next); return false;
      }
      this.position = next;
      if (next < this.options.words().length) this.options.onTick(next);
    }
    return true;
  }
  start(index = 0): void { this.seek(index); this.resume(); }
  resume(): void {
    if (this.disposed || this.intent) return;
    if (!this.active && this.next >= this.options.words().length && this.options.complete()) this.seek(0);
    const boundary = this.active ? this.position : this.next;
    if (!this.options.canStart(boundary)) { this.status("waiting-for-interaction"); this.options.onBlocked(boundary); return; }
    this.intent = true;
    void this.output.play().then(() => this.pump()).catch(error => this.fail(error));
    this.status(this.active ? "playing" : "preparing");
  }
  pause(): void { this.intent = false; this.chunkWaitStarted = null; this.output.pause(); this.status("paused"); }
  stop(): void { this.seek(0); }
  seek(index: number): void {
    this.pause(); this.generation++; this.revision.contentRevision++;
    this.lastChunkWaitMilliseconds = 0; this.lastMeasurements = null;
    this.observed.reset(); this.options.onObservedWpm?.(null);
    this.output.reset(); this.ready = []; this.active = null;
    this.consumedSamples = 0; this.remainingSamples = 0;
    this.position = Math.max(0, Math.min(index, Math.max(0, this.options.words().length - 1)));
    this.next = this.position; this.options.onTick(this.position); this.publish();
  }
  /** Apply new controls after the playing chunk, retaining the engine's native cache. */
  settingsChanged(): void {
    this.generation++; this.revision.synthesisRevision++; this.revision.dspRevision++;
    this.ready = []; void this.pump();
  }
  contentChanged(): void { const resume = this.intent; this.seek(this.position); if (resume) this.resume(); }
  appended(): void { if (this.intent) void this.pump(); }
  private async pump(): Promise<void> {
    if (!this.intent || this.disposed || this.scheduling) return;
    if (!this.active && this.ready.length) {
      const ready = this.ready.shift()!;
      const generation = this.generation;
      this.scheduling = true;
      try {
        if (ready.endWordExclusive > this.options.allowedEnd(ready.identity.startWord)) throw new Error("Interaction boundary changed; retry passage");
        if (ready.pcm.length === 0) {
          if (ready.words.some(word => word.startSample !== 0 || word.endSample !== 0)) throw new Error("Invalid unspoken word timing");
          this.next = ready.endWordExclusive;
          if (!this.advance(this.next)) return;
          if (this.next >= this.options.words().length && this.options.complete()) {
            this.intent = false; this.output.pause(); this.status("ended"); this.options.onEnd();
          } else {
            this.status("buffering");
            queueMicrotask(() => void this.pump());
          }
          return;
        }
        const rendered = await resampleAudio(ready.pcm, ready.sampleRate, this.output.sampleRate, ready.words);
        if (this.disposed || generation !== this.generation) return;
        if (ready.endWordExclusive > this.options.allowedEnd(ready.identity.startWord)) throw new Error("Interaction boundary changed; retry passage");
        this.active = { ...ready, ...rendered };
        this.activeSamples = rendered.pcm.length;
        this.consumedSamples = 0; this.remainingSamples = this.activeSamples;
        const speedRevision = `${ready.identity.synthesisRevision}:${ready.identity.dspRevision}`;
        if (speedRevision !== this.observedSettings) {
          this.observed.reset(); this.options.onObservedWpm?.(null); this.observedSettings = speedRevision;
        }
        this.observedChunkSamples = 0; this.observedChunkWords = 0;
        this.next = ready.endWordExclusive;
        this.output.reset(); this.output.enqueue(rendered.pcm);
        if (this.chunkWaitStarted !== null) {
          this.lastChunkWaitMilliseconds = performance.now() - this.chunkWaitStarted;
          this.chunkWaitStarted = null;
          if (this.lastMeasurements) this.options.onMeasurements?.({ ...this.lastMeasurements,
            lastChunkWaitMilliseconds: this.lastChunkWaitMilliseconds });
        }
        if (this.intent) {
          await this.output.play();
          if (this.intent && generation === this.generation) this.status("playing");
        }
      } catch (error) { if (generation === this.generation) this.fail(error); }
      finally {
        this.scheduling = false;
        if (generation !== this.generation && this.intent && !this.disposed) queueMicrotask(() => void this.pump());
      }
    }
    if (!this.intent || this.disposed || this.pending) return;
    if (!this.policy.shouldPrepare(this.ready.length, this.ready.reduce((n, chunk) => n + chunk.pcm.byteLength, 0),
      this.ready.reduce((n, chunk) => n + chunk.pcm.length / chunk.sampleRate, 0))) return;
    const start = this.ready[this.ready.length - 1]?.endWordExclusive ?? this.active?.endWordExclusive ?? this.next;
    const end = this.options.allowedEnd(start);
    if (end <= start || start >= this.options.words().length) return;
    let words = this.options.words().slice(start, Math.min(end, start + 60));
    // Wait for a complete clause at the temporary tail of a live source.
    if (!this.options.complete() && start + words.length === this.options.words().length &&
        words.some(word => normalizeSpeechText(word) !== "")) {
      let complete = words.length;
      while (complete > 0 && !/[.!?;:][”’"')\]]*$/.test(words[complete - 1].text)) complete--;
      words = words.slice(0, complete);
      if (!words.length) { if (!this.active) this.status("buffering"); return; }
    }
    const generation = this.generation;
    const settings = { ...this.options.settings() };
    this.pending = true; this.publish();
    try {
      const engine = await this.options.engine();
      if (this.disposed || generation !== this.generation) return;
      const revision = { ...this.revision };
      const result = await engine.prepare(words, settings, revision, end);
      if (!this.disposed && generation === this.generation) {
        if (!sameRevision(result.identity, revision) || result.identity.startWord !== start ||
            result.endWordExclusive <= start || result.endWordExclusive > end ||
            result.identity.endWordExclusive !== result.endWordExclusive || result.identity.allowedEndWordExclusive !== end ||
            result.words.length !== result.endWordExclusive - start ||
            result.words.some((word, index) => word.wordIndex !== start + index)) {
          throw new Error("Prepared speech does not match the current passage");
        }
        if (result.pcm.byteLength + this.ready.reduce((n, chunk) => n + chunk.pcm.byteLength, 0) > this.policy.maxBytes) {
          throw new Error("Prepared audio exceeds the buffer budget; increase speed or shorten the passage");
        }
        this.ready.push(result);
        if (result.pcm.length > 0) this.lastMeasurements = { provider: engine.provider ?? "unknown",
          lastChunkWaitMilliseconds: this.lastChunkWaitMilliseconds,
          initializationMilliseconds: engine.initializationMilliseconds, synthesisMilliseconds: result.synthesisMilliseconds,
          preparedSeconds: result.pcm.length / result.sampleRate,
          bufferedSeconds: this.ready.reduce((seconds, chunk) => seconds + chunk.pcm.length / chunk.sampleRate, 0),
          nativeCacheHit: result.nativeCacheHit ?? false,
          preparationMilliseconds: result.preparationMilliseconds ?? result.synthesisMilliseconds,
          phonemizationMilliseconds: result.phonemizationMilliseconds ?? 0, dspMilliseconds: result.dspMilliseconds ?? 0 };
        if (result.pcm.length > 0 && this.lastMeasurements) this.options.onMeasurements?.(this.lastMeasurements);
      }
    } catch (error) { if (generation === this.generation) this.fail(error); }
    finally {
      this.pending = false; this.publish();
      if (this.intent && !this.disposed) void this.pump();
    }
  }
  private fail(error: unknown): void {
    if (this.disposed) return;
    this.intent = false; this.output.pause();
    this.status("error", error instanceof Error ? error.message : String(error));
  }
  destroy(): void {
    this.disposed = true; this.intent = false; this.generation++;
    this.ready = []; this.active = null; this.remainingSamples = 0; this.phase = "paused";
    this.publish(); this.listeners.clear(); void this.output.dispose();
  }
}
