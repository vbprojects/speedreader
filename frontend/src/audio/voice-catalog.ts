import kittenCatalog from "./kitten-catalog.json";
import catalog from "./piper-catalog.json";
export const DEFAULT_VOICE = "piper_lessac";
export const PIPER_VOICES = catalog.voices;
export const PIPER_ROOT = `https://huggingface.co/rhasspy/piper-voices/resolve/${catalog.revision}/`;
export const QUALITY_LABELS: Record<string, string> = { x_low: "Extra low", low: "Low", medium: "Medium", high: "High" };
export function piperVoice(id: string) { return PIPER_VOICES.find(voice => voice.id === id); }
export function isPiperVoice(id: string): boolean { return piperVoice(id) !== undefined; }
export const KITTEN_VARIANTS = kittenCatalog.variants;
export const KITTEN_VOICES = kittenCatalog.voices.flatMap(voice => KITTEN_VARIANTS.map(variant => ({
  ...voice, id: `kitten_nano_${variant.id}_${voice.name.toLowerCase()}`, variant,
})));
export const DEFAULT_KITTEN_VOICE = "kitten_nano_int8_bella";
export function kittenVoice(id: string) { return KITTEN_VOICES.find(voice => voice.id === id); }
export function isKittenVoice(id: string): boolean { return kittenVoice(id) !== undefined; }
export function speechModelLabel(id: string): string { return isPiperVoice(id) ? "Piper" : isKittenVoice(id) ? "KittenTTS" : "Kokoro"; }
export function voiceLabel(id: string): string {
  const kitten = kittenVoice(id);
  if (kitten) return `KittenTTS · English · ${kitten.name} · Nano ${kitten.variant.label}`;
  const voice = piperVoice(id);
  return voice ? `Piper · English (US) · ${voice.name} · ${QUALITY_LABELS[voice.quality]}` : "Kokoro · English · Heart";
}
