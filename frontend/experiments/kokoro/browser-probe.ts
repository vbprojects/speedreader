import type { OnnxCommand, OnnxReply } from "../../src/audio/onnx-protocol";
import fixture from "./alignment-fixture.json";
import reference from "./duration-export.json";
const output = document.querySelector("#report")!;
async function probe(provider: "wasm" | "webgpu", pacingValues: readonly number[] = [.5, 1, 1.5, 4]) {
  const worker = new Worker(new URL("../../src/audio/kokoro.worker.ts", import.meta.url), { type: "module" });
  let sequence = 0;
  function request(command: Omit<Extract<OnnxCommand, { type: "initialize" }>, "id"> |
    Omit<Extract<OnnxCommand, { type: "synthesize" }>, "id">): Promise<OnnxReply> {
    return new Promise((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<OnnxReply>) => data.type === "error" ? reject(new Error(data.message)) : resolve(data);
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ ...command, id: ++sequence });
    });
  }
  const report: unknown[] = [];
  try {
    const [model, voice] = await Promise.all(["model_durations.onnx", "af_heart.bin"].map(async name => {
      const response = await fetch(new URL(`./output-browser/${name}`, import.meta.url));
      if (!response.ok) throw new Error(`Missing staged asset ${name}`);
      return response.arrayBuffer();
    }));
    report.push(await request({ type: "initialize", model, voice, provider,
      wasmUrl: new URL("../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm", import.meta.url).href }));
    for (const pacing of pacingValues) {
      const result = await request({ type: "synthesize", request: {
        identity: { sessionId: "probe", contentRevision: 1, synthesisRevision: 1, dspRevision: 1,
          requestId: String(sequence), chunkId: "fixture", startWord: 0, endWordExclusive: fixture.words.length,
          allowedEndWordExclusive: fixture.words.length },
        phonemeIds: fixture.modelTokens.map(t => t.modelTokenId), wordTokens: [], voice: "af_heart", pacing,
      } });
      if (result.type !== "synthesized") throw new Error("Unexpected worker reply");
      const expected = reference.measurements.find(m => m.pacing === pacing)!;
      report.push({ pacing, milliseconds: result.milliseconds, samples: result.pcm.length,
        maxDurationFrameDifference: Math.max(...result.durations.map((d, i) => Math.abs(d - expected.durations[i]))),
        expectedSamples: expected.samples });
      output.textContent = JSON.stringify(report, null, 2);
    }
    return report;
  } finally { worker.terminate(); }
}
for (const provider of ["wasm", "webgpu"] as const) document.querySelector(`#${provider}`)!.addEventListener("click", () => {
  output.textContent = `Testing ${provider}…`;
  void probe(provider).catch(error => { output.textContent = String(error); });
});
Object.assign(window, { kokoroProbe: probe });
