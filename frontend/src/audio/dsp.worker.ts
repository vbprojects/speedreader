import { compressAudio } from "./dsp";
import type { WordSampleSpan } from "./alignment";
const worker = self as unknown as { onmessage: (event: MessageEvent<{
  pcm: Float32Array; sampleRate: number; compression: number; words: WordSampleSpan[];
}>) => void; postMessage(message: unknown, transfer?: Transferable[]): void };
worker.onmessage = ({ data }) => {
  try {
    const result = compressAudio(data.pcm, data.sampleRate, data.compression, data.words);
    worker.postMessage({ result }, [result.pcm.buffer]);
  } catch (error) { worker.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
