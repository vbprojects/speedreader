/** Render-thread queue. Cursor advances only for consumed PCM, never underrun silence. */
export class PcmQueue {
  private chunks: Float32Array[] = [];
  private offset = 0;
  private queued = 0;
  private consumed = 0;
  private playing = false;
  constructor(readonly capacitySamples: number) {
    if (!Number.isSafeInteger(capacitySamples) || capacitySamples <= 0) throw new Error("Invalid PCM budget");
  }
  get cursor(): number { return this.consumed; }
  get remaining(): number { return this.queued; }
  setPlaying(value: boolean): void { this.playing = value; }
  enqueue(pcm: Float32Array): void {
    if (pcm.length + this.queued > this.capacitySamples) throw new Error("PCM queue budget exceeded");
    if (pcm.length) { this.chunks.push(pcm); this.queued += pcm.length; }
  }
  reset(cursor = 0): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid sample cursor");
    this.chunks = []; this.offset = 0; this.queued = 0; this.consumed = cursor; this.playing = false;
  }
  render(output: Float32Array): number {
    output.fill(0);
    if (!this.playing) return 0;
    let written = 0;
    while (written < output.length && this.chunks.length) {
      const chunk = this.chunks[0];
      const count = Math.min(output.length - written, chunk.length - this.offset);
      output.set(chunk.subarray(this.offset, this.offset + count), written);
      written += count; this.offset += count;
      if (this.offset === chunk.length) { this.chunks.shift(); this.offset = 0; }
    }
    this.queued -= written; this.consumed += written;
    return written;
  }
}
