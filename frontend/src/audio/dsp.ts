import { Stretch } from "@soundtouchjs/core";
import type { WordSampleSpan } from "./alignment";
export const DSP_REVISION = "soundtouch-core-2.1.1-wsola-landmarks-2";
export interface SampleLandmark { source: number; output: number; }
export interface ProcessedAudio {
  pcm: Float32Array;
  sampleRate: number;
  words: WordSampleSpan[];
  landmarks: SampleLandmark[];
  /** Crossfades mix adjacent source windows; landmarks are not single-sample identity. */
  alignment: "identity" | "wsola-window-interpolation";
}
export function mapSample(sample: number, landmarks: readonly SampleLandmark[]): number {
  if (landmarks.length < 2 || sample < landmarks[0].source || sample > landmarks[landmarks.length - 1].source) {
    throw new Error("Sample is outside DSP mapping");
  }
  let low = 0, high = landmarks.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (landmarks[middle].source <= sample) low = middle; else high = middle;
  }
  const a = landmarks[low], b = landmarks[high];
  return a.output + (sample - a.source) / (b.source - a.source) * (b.output - a.output);
}

/** Prepared-chunk DSP, intended to execute in the preparation worker. */
export function compressAudio(pcm: Float32Array, sampleRate: number, compression: number,
  words: readonly WordSampleSpan[]): ProcessedAudio {
  if (!Number.isFinite(compression) || compression < .5 || compression > 4 ||
      !Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || pcm.length === 0) {
    throw new Error("Invalid DSP input");
  }
  for (const word of words) if (word.startSample < 0 || word.endSample < word.startSample || word.endSample > pcm.length) {
    throw new Error("Word is outside native PCM");
  }
  if (compression === 1) return { pcm: pcm.slice(), sampleRate, words: words.map(w => ({ ...w })),
    landmarks: [{ source: 0, output: 0 }, { source: pcm.length, output: pcm.length }], alignment: "identity" };
  // Flush at least three complete input windows on either side. A fixed
  // millisecond pad can leave the final landmark short of uneven chunk ends.
  const sizing = new Stretch({ sampleRate });
  sizing.tempo = compression;
  const pad = Math.max(Math.ceil(sampleRate * .3), sizing.inputChunkSize * 3);
  const total = pcm.length + pad * 2;
  const stereo = new Float32Array(total * 2);
  for (let i = 0; i < pcm.length; i++) stereo[(i + pad) * 2] = stereo[(i + pad) * 2 + 1] = pcm[i];
  const landmarks: SampleLandmark[] = [];
  class MappedStretch extends Stretch {
    override seekBestOverlapPosition(input?: Parameters<Stretch["seekBestOverlapPosition"]>[0]): number {
      const offset = super.seekBestOverlapPosition(input);
      // Beginning of the unblended middle copied by processOneWindow in pinned 2.1.1.
      const source = total - this.inputBuffer!.frameCount + offset + this.overlapLength;
      const output = this.outputBuffer!.frameCount + this.overlapLength;
      const last = landmarks[landmarks.length - 1];
      if (last && (source <= last.source || output <= last.output)) throw new Error("Nonmonotonic DSP mapping");
      landmarks.push({ source, output });
      return offset;
    }
  }
  const stretch = new MappedStretch({ createBuffers: true, sampleRate });
  stretch.tempo = compression;
  stretch.inputBuffer!.putSamples(stereo);
  stretch.process();
  const start = Math.round(mapSample(pad, landmarks));
  const end = Math.max(start + 1, Math.round(mapSample(pad + pcm.length, landmarks)));
  if (end > stretch.outputBuffer!.frameCount || end <= start) throw new Error("Incomplete DSP output");
  const processed = new Float32Array((end - start) * 2);
  stretch.outputBuffer!.extract(processed, start, end - start);
  const output = Float32Array.from({ length: end - start }, (_, i) => processed[i * 2]);
  const map = (sample: number) => sample === pcm.length ? output.length : sample === 0 ? 0 : Math.max(0, Math.min(output.length, Math.round(mapSample(sample + pad, landmarks)) - start));
  return { pcm: output, sampleRate, words: words.map(word => ({ wordIndex: word.wordIndex,
    startSample: map(word.startSample), endSample: map(word.endSample) })),
    landmarks: landmarks.map(point => ({ source: point.source - pad, output: point.output - start })),
    alignment: "wsola-window-interpolation" };
}
