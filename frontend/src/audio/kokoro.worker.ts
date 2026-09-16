import type { PiperConfig } from "./piper-input";
import * as ort from "onnxruntime-web/webgpu";
import { selectVoiceStyle } from "./model-input";
import type { OnnxCommand, OnnxReply } from "./onnx-protocol";

const worker = self as unknown as { onmessage: ((event: MessageEvent<OnnxCommand>) => void) | null;
  postMessage(message: OnnxReply, transfer?: Transferable[]): void };
let session: ort.InferenceSession | null = null;
let voice: Float32Array | null = null;
let busy = false;
let piper: PiperConfig | null = null;
const DURATION_OUTPUT = "/encoder/Gather_output_0";
let durationOutput = DURATION_OUTPUT;

worker.onmessage = async ({ data }) => {
  if (busy) { worker.postMessage({ type: "error", id: data.id, message: "Inference worker is busy" }); return; }
  busy = true;
  try {
    if (data.type === "initialize") {
      if (session) throw new Error("Dispose the prior session before initializing");
      const url = new URL(data.wasmUrl, self.location.href);
      if (url.origin !== self.location.origin) throw new Error("Runtime assets must be installed locally");
      // Baseline works without COOP/COEP. This dedicated worker is not ORT's proxy worker.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = { wasm: url.href };
      const start = performance.now();
      session = await ort.InferenceSession.create(data.model, { executionProviders: [data.provider] });
      durationOutput = data.kind === "piper" ? "/Ceil_output_0" : DURATION_OUTPUT;
      if (!session.outputNames.includes(durationOutput)) {
        await session.release(); session = null;
        throw new Error("This graph does not expose native durations");
      }
      piper = data.kind === "piper" ? JSON.parse(new TextDecoder().decode(data.voice)) as PiperConfig : null;
      voice = piper ? new Float32Array() : new Float32Array(data.voice);
      worker.postMessage({ type: "initialized", id: data.id, provider: data.provider, milliseconds: performance.now() - start });
    } else if (data.type === "synthesize") {
      if (!session || !voice) throw new Error("Voice is not initialized");
      const { phonemeIds: ids, pacing, identity } = data.request;
      if (ids.length < 3 || ids.length > (piper ? 2048 : 512) || ids[0] !== (piper ? 1 : 0) || ids[ids.length - 1] !== (piper ? 2 : 0) || ids.some(id => !Number.isSafeInteger(id) || id < 0 || id > (piper ? 255 : 177)) ||
          !Number.isFinite(pacing) || pacing < .5 || pacing > 4) throw new Error("Invalid synthesis input; text is never truncated");
      if (identity.endWordExclusive > identity.allowedEndWordExclusive) throw new Error("Synthesis crosses an interaction boundary");
      const feeds: Record<string, ort.Tensor> = piper ? {
        input: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
        input_lengths: new ort.Tensor("int64", BigInt64Array.of(BigInt(ids.length)), [1]),
        scales: new ort.Tensor("float32", Float32Array.of(piper.inference.noise_scale,
          piper.inference.length_scale / pacing, piper.inference.noise_w), [3]),
      } : {
        input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
        style: new ort.Tensor("float32", selectVoiceStyle(voice, ids.length), [1, 256]),
        speed: new ort.Tensor("float32", Float32Array.of(pacing), [1]),
      };
      const start = performance.now();
      try {
        const outputs = await session.run(feeds);
        try {
          const pcm = Float32Array.from(outputs[piper ? "output" : "waveform"].data as Float32Array);
          const durations = Array.from(outputs[durationOutput].data as BigInt64Array, Number);
          if (pcm.some(sample => !Number.isFinite(sample)) || durations.length !== ids.length || durations.some(d => !Number.isSafeInteger(d) || d < (piper ? 0 : 1)) ||
              durations.reduce((n, d) => n + d, 0) * (piper ? 256 : 600) !== pcm.length) throw new Error("Unexpected model sample geometry");
          worker.postMessage({ type: "synthesized", id: data.id, identity, pcm, durations,
            milliseconds: performance.now() - start }, [pcm.buffer]);
        } finally { Object.values(outputs).forEach(tensor => tensor.dispose()); }
      } finally { Object.values(feeds).forEach(tensor => tensor.dispose()); }
    } else {
      await session?.release(); session = null; voice = null;
      worker.postMessage({ type: "disposed", id: data.id });
    }
  } catch (error) {
    worker.postMessage({ type: "error", id: data.id, message: error instanceof Error ? error.message : String(error) });
  } finally { busy = false; }
};
