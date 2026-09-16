import catalog from "./piper-catalog.json";
export const DEFAULT_VOICE = "piper_lessac";
export const PIPER_VOICES = catalog.voices;
export const PIPER_ROOT = `https://huggingface.co/rhasspy/piper-voices/resolve/${catalog.revision}/`;
export const QUALITY_LABELS: Record<string, string> = { x_low: "Extra low", low: "Low", medium: "Medium", high: "High" };
export function piperVoice(id: string) { return PIPER_VOICES.find(voice => voice.id === id); }
export function isPiperVoice(id: string): boolean { return piperVoice(id) !== undefined; }
export function voiceLabel(id: string): string {
  const voice = piperVoice(id);
  return voice ? `Piper · English (US) · ${voice.name} · ${QUALITY_LABELS[voice.quality]}` : "Kokoro · English · Heart";
}
