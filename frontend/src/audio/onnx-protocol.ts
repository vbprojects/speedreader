import type { SynthesisRequest } from "./protocol";
export type OnnxCommand =
  | { type: "initialize"; id: number; model: ArrayBuffer; voice: ArrayBuffer; wasmUrl: string; provider: "wasm" | "webgpu"; kind?: "kokoro" | "piper" }
  | { type: "synthesize"; id: number; request: SynthesisRequest }
  | { type: "dispose"; id: number };
export type OnnxReply =
  | { type: "initialized"; id: number; provider: "wasm" | "webgpu"; milliseconds: number }
  | { type: "synthesized"; id: number; identity: SynthesisRequest["identity"]; pcm: Float32Array; durations: number[]; milliseconds: number }
  | { type: "disposed"; id: number }
  | { type: "error"; id: number; message: string };
