import { PcmQueue } from "./pcm-queue";
declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
class PcmProcessor extends AudioWorkletProcessor {
  private queue = new PcmQueue(sampleRate * 120);
  private revision = 0;
  private framesSinceReport = 0;
  private previousRemaining = 0;
  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      try {
        if (data.type === "reset") { this.revision = data.revision; this.queue.reset(data.cursor); }
        else if (data.revision === this.revision) {
          if (data.type === "pcm") this.queue.enqueue(data.pcm);
          if (data.type === "play") this.queue.setPlaying(true);
          if (data.type === "pause") this.queue.setPlaying(false);
        }
      } catch (error) { this.port.postMessage({ type: "error", revision: this.revision, message: String(error) }); }
    };
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (output) {
      const written = this.queue.render(output);
      for (const channel of outputs[0].slice(1)) channel.set(output);
      this.framesSinceReport += output.length;
      if (this.framesSinceReport >= sampleRate / 60 || (this.previousRemaining > 0 && this.queue.remaining === 0)) {
        this.framesSinceReport = 0;
        this.port.postMessage({ type: "cursor", revision: this.revision, sample: this.queue.cursor,
          remaining: this.queue.remaining, underrun: written < output.length });
      }
      this.previousRemaining = this.queue.remaining;
    }
    return true;
  }
}
registerProcessor("speedreader-pcm", PcmProcessor);
