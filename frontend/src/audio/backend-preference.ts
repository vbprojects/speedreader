export type SpeechBackend = "wasm" | "webgpu";
export const BACKEND_STORAGE_KEY = "speedreader.audio.backend.v1";
export function loadSpeechBackend(storage?: Pick<Storage, "getItem">): SpeechBackend {
  try { return (storage ?? localStorage).getItem(BACKEND_STORAGE_KEY) === "webgpu" ? "webgpu" : "wasm"; }
  catch { return "wasm"; }
}
export function saveSpeechBackend(backend: SpeechBackend, storage?: Pick<Storage, "setItem">): void {
  (storage ?? localStorage).setItem(BACKEND_STORAGE_KEY, backend);
}
