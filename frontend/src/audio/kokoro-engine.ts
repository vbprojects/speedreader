import { DEFAULT_SPEECH_TEXT_PROFILE, type SpeechTextProfile } from "./speech-text";
import { isPiperVoice } from "./voice-catalog";
import { exposePiperDurations } from "./duration-export";
import { piperInput, type PiperConfig } from "./piper-input";
import type { Word } from "../epub/types";
import { alignWordSamples } from "./alignment";
import { BoundedCache, nativeCacheKey, processedCacheKey } from "./bounded-cache";
import { DSP_REVISION, type ProcessedAudio } from "./dsp";
import { DspClient } from "./dsp-client";
import { OnnxClient } from "./onnx-client";
import { EnglishPhonemizer, phonemizeChunk } from "./phonemizer";
import { phraseWordCount } from "./phrase-boundary";
import vocabulary from "./vendor/kokoro-vocabulary.json";
import { packForVoice } from "./voice-pack";
import type { PackAsset } from "./pack-store";
import type { AudioRevision, ChunkIdentity } from "./protocol";
import type { AudioSettings } from "./settings";

export interface PreparedSpeech extends ProcessedAudio {
  identity: ChunkIdentity;
  endWordExclusive: number;
  synthesisMilliseconds: number;
  nativeCacheHit?: boolean;
  preparationMilliseconds?: number;
  phonemizationMilliseconds?: number;
  dspMilliseconds?: number;
}
/** Preparation boundary: alternate scheduling/backends can satisfy this contract. */
export interface SpeechProducer {
  readonly provider: string | null;
  readonly initializationMilliseconds: number;
  prepare(words: readonly Word[], settings: AudioSettings, revision: AudioRevision,
    allowedEndWordExclusive: number, signal?: AbortSignal): Promise<PreparedSpeech>;
}
export class KokoroEngine implements SpeechProducer {
  constructor(private selectedVoice = "af_heart", private textProfile: SpeechTextProfile = DEFAULT_SPEECH_TEXT_PROFILE) {
    if (selectedVoice !== "af_heart" && !isPiperVoice(selectedVoice)) throw new Error("This experimental voice is not supported");
  }
  private get pack() { return packForVoice(this.selectedVoice); }
  private piper: PiperConfig | null = null;
  private get sampleRate() { return this.piper?.audio.sample_rate ?? 24000; }
  private client: OnnxClient | null = null;
  private phonemizer: EnglishPhonemizer | null = null;
  private runtimeUrl: string | null = null;
  private native = new BoundedCache<{ pcm: Float32Array; durations: number[] }>(24_000 * 4 * 120, 12);
  private processed = new BoundedCache<ProcessedAudio>(24_000 * 4 * 90, 8);
  private disposed = false;
  private dsp: DspClient | null = null;
  private sequence = 0;
  private preparationQueue: Promise<unknown> = Promise.resolve();
  provider: "wasm" | "webgpu" | null = null;
  initializationMilliseconds = 0;
  async initialize(resolve: (asset: PackAsset) => Promise<ArrayBuffer>, preferred: "auto" | "wasm" | "webgpu" = "auto"): Promise<void> {
    if (this.disposed || this.client) throw new Error("Engine cannot initialize twice");
    const asset = (role: PackAsset["role"]) => this.pack.assets.find(a => a.role === role)!;
    // Sequential reads bound verification/allocation memory.
    const dictionary = await resolve(asset("phonemizer"));
    this.phonemizer = new EnglishPhonemizer(new TextDecoder().decode(dictionary), vocabulary, this.textProfile);
    const runtime = await resolve(asset("runtime"));
    this.runtimeUrl = URL.createObjectURL(new Blob([runtime], { type: "application/wasm" }));
    // Successful GPU execution and valid sample geometry do not establish
    // audible correctness. Keep WebGPU opt-in for diagnostic probes until
    // this quantized graph has passed waveform/listening checks on real GPUs.
    const providers: ("wasm" | "webgpu")[] = preferred === "auto" ? ["wasm"] : [preferred];
    let failure: unknown;
    for (const provider of providers) {
      const client = new OnnxClient();
      this.client = client;
      try {
        let model = await resolve(asset("model"));
        const voice = await resolve(asset("voice"));
        this.piper = isPiperVoice(this.selectedVoice) ? JSON.parse(new TextDecoder().decode(voice)) as PiperConfig : null;
        if (this.piper && this.selectedVoice !== "piper_lessac") model = exposePiperDurations(model);
        if (this.disposed) throw new Error("Engine disposed during initialization");
        const reply = await client.initialize(model, voice, this.runtimeUrl, provider, this.piper ? "piper" : "kokoro");
        if (reply.type !== "initialized") throw new Error("Unexpected initialization response");
        this.provider = provider; this.initializationMilliseconds = reply.milliseconds;
        return;
      } catch (error) { client.dispose(); this.client = null; failure = error; if (this.disposed) break; }
    }
    this.dispose(); throw failure;
  }
  prepare(words: readonly Word[], settings: AudioSettings, revision: AudioRevision,
    allowedEndWordExclusive: number, signal?: AbortSignal): Promise<PreparedSpeech> {
    const result = this.preparationQueue.catch(() => undefined).then(async () => {
      signal?.throwIfAborted();
      const result = await this.prepareChunk(words, settings, revision, allowedEndWordExclusive);
      signal?.throwIfAborted();
      return result;
    });
    this.preparationQueue = result;
    return result;
  }
  private async prepareChunk(words: readonly Word[], settings: AudioSettings, revision: AudioRevision,
    allowedEndWordExclusive: number): Promise<PreparedSpeech> {
    if (!this.client || !this.phonemizer || this.disposed) throw new Error("Voice is not ready");
    if (settings.readAloudVoice !== this.selectedVoice) throw new Error("Selected voice changed; restart speech");
    const preparationStart = performance.now();
    const allowed = words.filter(word => word.index < allowedEndWordExclusive);
    const english = phonemizeChunk(this.phonemizer, allowed.slice(0, phraseWordCount(allowed)));
    const phrase = this.piper ? piperInput(english, this.piper) : english;
    if (phrase.words.every(word => word.tokenStart === word.tokenEnd)) {
      const source = allowed.slice(0, english.words.length);
      const end = source[source.length - 1].index + 1;
      return { pcm: new Float32Array(), sampleRate: this.sampleRate,
        words: source.map(word => ({ wordIndex: word.index, startSample: 0, endSample: 0 })),
        landmarks: [], alignment: "identity", endWordExclusive: end, synthesisMilliseconds: 0,
        identity: { ...revision, requestId: String(++this.sequence), chunkId: String(source[0].index),
          startWord: source[0].index, endWordExclusive: end, allowedEndWordExclusive } };
    }
    const phonemizationMilliseconds = performance.now() - preparationStart;
    const source = allowed.slice(0, phrase.words.length);
    const identity: ChunkIdentity = { ...revision, requestId: String(++this.sequence), chunkId: String(source[0].index),
      startWord: source[0].index, endWordExclusive: source[source.length - 1].index + 1, allowedEndWordExclusive };
    const key = nativeCacheKey({ model: this.pack.version, runtime: this.pack.runtimeRevision,
      voice: settings.readAloudVoice, pacing: settings.kokoroPacing, phonemeIds: phrase.ids });
    let native = this.native.get(key), synthesisMilliseconds = 0;
    const nativeCacheHit = native !== undefined;
    if (!native) {
      const result = await this.client.synthesize({ identity, phonemeIds: phrase.ids, wordTokens: phrase.words,
        voice: settings.readAloudVoice, pacing: settings.kokoroPacing });
      if (this.disposed) throw new Error("Engine disposed during synthesis");
      native = { pcm: result.pcm, durations: result.durations }; synthesisMilliseconds = result.milliseconds;
      this.native.put(key, native, native.pcm.byteLength + native.durations.length * 8);
    }
    const aligned = alignWordSamples(source, phrase.words, native.durations, {
      samplesPerFrame: this.piper ? 256 : 600, sampleOffset: 0, waveformSamples: native.pcm.length,
    });
    const processedKey = processedCacheKey(key, DSP_REVISION, settings.speechCompression, this.sampleRate) + JSON.stringify(phrase.words);
    const dspStart = performance.now();
    let processed = this.processed.get(processedKey);
    if (!processed) {
      this.dsp ??= new DspClient();
      processed = await this.dsp.process(native.pcm, this.sampleRate, settings.speechCompression, aligned);
      this.processed.put(processedKey, processed, processed.pcm.byteLength + processed.landmarks.length * 16);
    }
    return { ...processed, identity, endWordExclusive: identity.endWordExclusive, synthesisMilliseconds, nativeCacheHit,
      phonemizationMilliseconds, dspMilliseconds: performance.now() - dspStart,
      preparationMilliseconds: performance.now() - preparationStart };
  }
  dispose(): void {
    this.disposed = true; this.client?.dispose(); this.client = null;
    this.native.clear(); this.processed.clear(); this.phonemizer = null; this.dsp?.dispose(); this.dsp = null;
    if (this.runtimeUrl) URL.revokeObjectURL(this.runtimeUrl); this.runtimeUrl = null;
  }
}
