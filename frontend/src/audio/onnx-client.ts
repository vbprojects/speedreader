import type { OnnxCommand, OnnxReply } from "./onnx-protocol";
import type { SynthesisRequest } from "./protocol";
export class OnnxClient {
  private worker = new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module" });
  private sequence = 0;
  private pending: { resolve: (reply: OnnxReply) => void; reject: (error: Error) => void; id: number } | null = null;
  private disposed = false;
  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<OnnxReply>) => {
      const pending = this.pending;
      if (!pending || pending.id !== data.id) return;
      this.pending = null;
      if (data.type === "error") pending.reject(new Error(data.message)); else pending.resolve(data);
    };
    this.worker.onerror = event => { this.pending?.reject(new Error(event.message)); this.pending = null; };
  }
  private request(command: OnnxCommand, transfer: Transferable[] = []): Promise<OnnxReply> {
    if (this.disposed) return Promise.reject(new Error("Synthesis worker is disposed"));
    if (this.pending) return Promise.reject(new Error("Synthesis is already in progress"));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, id: command.id };
      try { this.worker.postMessage(command, transfer); } catch (error) { this.pending = null; reject(error); }
    });
  }
  initialize(model: ArrayBuffer, voice: ArrayBuffer, wasmUrl: string, provider: "wasm" | "webgpu", kind: "kokoro" | "piper" = "kokoro") {
    return this.request({ type: "initialize", id: ++this.sequence, model, voice, wasmUrl, provider, kind }, [model, voice]);
  }
  async synthesize(request: SynthesisRequest) {
    const reply = await this.request({ type: "synthesize", id: ++this.sequence, request });
    if (reply.type !== "synthesized") throw new Error("Unexpected synthesis reply");
    return reply;
  }
  dispose(): void {
    this.disposed = true; this.worker.terminate();
    this.pending?.reject(new Error("Synthesis worker disposed")); this.pending = null;
  }
}
