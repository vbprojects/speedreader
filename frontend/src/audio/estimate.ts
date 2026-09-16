import type { AudioSettings } from "./settings";
import type { WpmProfile } from "./profiles";

export interface EstimateContext {
  modelRevision: string;
  language: string;
}

export type WpmEstimate =
  | { status: "unavailable"; profileId: string; reason: "invalid-settings" | "incompatible-profile" }
  | { status: "experimental" | "calibrated"; profileId: string; wpm: number; roundedWpm: number; extrapolated: boolean };

/** Display only. Neither timestamps nor production throughput can be derived here. */
export function estimateWpm(
  settings: Pick<AudioSettings, "readAloudVoice" | "kokoroPacing" | "speechCompression">,
  context: EstimateContext,
  profile: WpmProfile,
): WpmEstimate {
  const { kokoroPacing: p, speechCompression: c } = settings;
  if (![p, c].every(n => Number.isFinite(n) && n >= 0.5 && n <= 4)) {
    return { status: "unavailable", profileId: profile.id, reason: "invalid-settings" };
  }
  if (settings.readAloudVoice !== profile.voice || context.modelRevision !== profile.modelRevision || context.language !== profile.language) {
    return { status: "unavailable", profileId: profile.id, reason: "incompatible-profile" };
  }
  if (!Number.isFinite(profile.maximum) || profile.maximum <= 0 ||
      !Number.isFinite(profile.halfSaturationSquared) || profile.halfSaturationSquared <= 0) {
    throw new Error("Invalid WPM profile coefficients");
  }
  const extrapolated = p < profile.pacingRange[0] || p > profile.pacingRange[1] ||
    c < profile.compressionRange[0] || c > profile.compressionRange[1];
  const wpm = c * profile.maximum * p * p / (profile.halfSaturationSquared + p * p);
  return {
    status: profile.browserValidated && !extrapolated ? "calibrated" : "experimental",
    profileId: profile.id,
    wpm,
    roundedWpm: Math.round(wpm / 5) * 5,
    extrapolated,
  };
}
