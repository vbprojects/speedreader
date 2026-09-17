import { awaitAudioStartup, requestPlaybackSession } from "./audio-startup";
import { OutputWatchdog } from "./output-watchdog";
import type { WordSampleSpan } from "./alignment";
export interface OutputCursor { sample: number; remaining: number; underrun: boolean; }
/** Thin replaceable browser sink: no word timers or synthesis policy. */
export class AudioOutput {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private revision = 0;
  private disposed = false;
  private initializing: Promise<void> | null = null;
  private intent = false;
  private resuming = false;
  private started = false;
  private queuedAudio = false;
  private expectedSamples = 0;
  private watchdog = new OutputWatchdog();
  private monitor: ReturnType<typeof setInterval> | null = null;
  constructor(private onCursor: (cursor: OutputCursor) => void, private onError: (error: Error) => void) {}
  get sampleRate(): number { return this.context?.sampleRate ?? 0; }
  get latencySeconds(): number { return (this.context?.baseLatency ?? 0) + (this.context?.outputLatency ?? 0); }
  async initialize(): Promise<void> {
    if (this.disposed) throw new Error("Audio output is disposed");
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const context = new AudioContext({ latencyHint: "interactive", sampleRate: 24_000 });
      // Keep one mixer at the model rate. The browser converts its destination
      // to the device rate, avoiding a fresh resampling context for every chunk.
      this.context = context;
      context.onstatechange = () => {
        if (this.started && this.intent && !this.resuming && !this.disposed && context.state !== "running") {
          this.onError(new Error("Audio was interrupted. Press Play to resume audio."));
        }
      };
      const { default: workletUrl } = await import("./pcm.worklet.ts?worker&url");
      await context.audioWorklet.addModule(workletUrl);
      if (this.disposed) { if (context.state !== "closed") await context.close(); return; }
      const node = new AudioWorkletNode(context, "speedreader-pcm", { outputChannelCount: [1], numberOfInputs: 0 });
      node.port.onmessage = ({ data }) => {
        if (data.revision !== this.revision || this.disposed) return;
        if (data.type === "error") this.onError(new Error(data.message));
        if (data.type === "cursor") { this.queuedAudio = data.sample < this.expectedSamples; this.onCursor(data); }
      };
      node.onprocessorerror = () => { if (!this.disposed) this.onError(new Error("Audio renderer stopped; resume audio to retry")); };
      node.connect(context.destination);
      this.node = node;
      this.monitor = setInterval(() => {
        if (this.watchdog.check(context.currentTime, performance.now(), this.intent && this.queuedAudio)) {
          this.pause();
          this.onError(new Error("The audio device stopped advancing. Reset the voice and press Play to retry."));
        }
      }, 1000);
      this.send({ type: "reset", cursor: 0 });
      if (this.intent) this.send({ type: "play" });
    })();
    try { await this.initializing; } catch (error) {
      if (this.context && this.context.state !== "closed") await this.context.close(); this.context = null; this.initializing = null;
      throw error;
    }
  }
  private send(message: object, transfers: Transferable[] = []): void {
    this.node?.port.postMessage({ ...message, revision: this.revision }, transfers);
  }
  async play(): Promise<void> {
    requestPlaybackSession(navigator as Navigator & { audioSession?: { type: string } });
    this.intent = true;
    this.resuming = true;
    // Initialize creates the context synchronously before awaiting its worklet.
    // Resume now, inside the user gesture, rather than after model/module I/O.
    const initialized = this.initialize();
    const resumed = this.context?.resume();
    try {
      await awaitAudioStartup(Promise.all([initialized, resumed]), () => this.context?.state ?? "no context");
      if (this.context?.state !== "running") throw new Error(`Audio device is ${this.context?.state ?? "unavailable"}. Press Play to retry.`);
      this.started = true;
    } catch (error) {
      this.pause();
      throw error;
    }
    finally { this.resuming = false; }
    if (this.intent && !this.disposed) this.send({ type: "play" });
  }
  pause(): void { this.intent = false; this.send({ type: "pause" }); }
  reset(): void { this.pause(); this.queuedAudio = false; this.expectedSamples = 0; this.revision++; this.send({ type: "reset", cursor: 0 }); }
  enqueue(pcm: Float32Array): void {
    if (!this.node || this.disposed) throw new Error("Audio output is unavailable");
    this.expectedSamples += pcm.length;
    this.queuedAudio ||= pcm.length > 0;
    this.send({ type: "pcm", pcm }, [pcm.buffer]);
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.pause(); this.revision++;
    if (this.monitor !== null) clearInterval(this.monitor); this.monitor = null;
    this.node?.disconnect(); this.node?.port.close(); this.node = null;
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.context = null;
  }
}

export async function resampleAudio(pcm: Float32Array, sourceRate: number, outputRate: number,
  words: readonly WordSampleSpan[]): Promise<{ pcm: Float32Array; words: WordSampleSpan[] }> {
  if (sourceRate === outputRate) return { pcm: pcm.slice(), words: words.map(word => ({ ...word })) };
  const length = Math.ceil(pcm.length * outputRate / sourceRate);
  const context = new OfflineAudioContext(1, length, outputRate);
  const buffer = context.createBuffer(1, pcm.length, sourceRate);
  buffer.copyToChannel(Float32Array.from(pcm), 0);
  const source = context.createBufferSource(); source.buffer = buffer;
  source.connect(context.destination); source.start();
  const rendered = await context.startRendering();
  return { pcm: rendered.getChannelData(0).slice(), words: words.map(word => ({ wordIndex: word.wordIndex,
    startSample: Math.round(word.startSample * outputRate / sourceRate),
    endSample: Math.min(length, Math.round(word.endSample * outputRate / sourceRate)) })) };
}
