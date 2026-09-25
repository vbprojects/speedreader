import { DEFAULT_VOICE, isPiperVoice } from "./voice-catalog";
/** Persisted preferences only; installation and playback state live elsewhere. */
export interface AudioSettings {
  readAloudEnabled: boolean;
  readAloudInBackground: boolean;
  readAloudVoice: string;
  kokoroPacing: number;
  speechCompression: number;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  readAloudEnabled: false,
  readAloudInBackground: true,
  readAloudVoice: DEFAULT_VOICE,
  kokoroPacing: 1,
  speechCompression: 1,
};

/** Invalid overrides are omitted, so per-book settings retain valid inheritance. */
export function audioSettingsPatch(value: unknown): Partial<AudioSettings> {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const result: Partial<AudioSettings> = {};
  if (typeof input.readAloudInBackground === "boolean") result.readAloudInBackground = input.readAloudInBackground;
  if (typeof input.readAloudEnabled === "boolean") result.readAloudEnabled = input.readAloudEnabled;
  if (typeof input.readAloudVoice === "string" && (isPiperVoice(input.readAloudVoice) || /^[ab][fm]_[a-z0-9_]{1,48}$/.test(input.readAloudVoice))) {
    result.readAloudVoice = input.readAloudVoice;
  }
  for (const key of ["kokoroPacing", "speechCompression"] as const) {
    const n = input[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0.5 && n <= 4) result[key] = n;
  }
  return result;
}
