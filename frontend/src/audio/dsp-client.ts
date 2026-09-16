import type { WordSampleSpan } from "./alignment";
import type { ProcessedAudio } from "./dsp";
export class DspClient {
  private worker = new Worker(new URL("./dsp.worker.ts", import.meta.url), { type: "module" });
  private rejectPending: ((error: Error) => void) | null = null;
  private disposed = false;
  process(pcm: Float32Array, sampleRate: number, compression: number, words: readonly WordSampleSpan[]): Promise<ProcessedAudio> {
    if (this.disposed || this.rejectPending) return Promise.reject(new Error("DSP worker is unavailable"));
    return new Promise((resolve, reject) => {
      this.rejectPending = reject;
      this.worker.onmessage = ({ data }) => {
        this.rejectPending = null;
        if (data.error) reject(new Error(data.error)); else resolve(data.result);
      };
      this.worker.onerror = event => { this.rejectPending = null; reject(new Error(event.message)); };
      // Native cache retains its own PCM for future compression changes.
      const copy = pcm.slice();
      this.worker.postMessage({ pcm: copy, sampleRate, compression, words }, [copy.buffer]);
    });
  }
  dispose(): void {
    this.disposed = true; this.worker.terminate();
    this.rejectPending?.(new Error("DSP worker disposed")); this.rejectPending = null;
  }
}
