// src/settings/types.ts
// Settings model: global (library-wide) + per-reader (local) settings.
// Per-reader settings override global ones for that reader instance.

export type Theme = "light" | "dark" | "sepia" | "high-contrast";
export type PacingAlgorithm =
  | "naive"
  | "bayesian"
  | "surprisal-normal"
  | "surprisal-exponential-gamma"
  | "surprisal-lognormal-nig";

/** Global settings — apply to the whole app / library view. */
export interface GlobalSettings {
  theme: Theme;
  /** Default font family for the reader. */
  fontFamily: string;
  /** Default font size (px) for the reader. */
  fontSize: number;
  /** Default WPM. */
  wpm: number;
  /** Sentence pause (ms). */
  sentencePauseMs: number;
  /** Paragraph pause (ms). */
  paragraphPauseMs: number;
  /** Pacing algorithm model. */
  pacingModel: PacingAlgorithm;
  /** Forgetting / discounting factor gamma for Bayesian model (e.g., 0.90 to 0.999). */
  bayesianGamma: number;
}

/** Per-reader settings — override global for one reader instance. */
export type ReaderSettings = Partial<GlobalSettings>;

/** The full settings state: global + per-reader overrides. */
export interface SettingsState {
  global: GlobalSettings;
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  theme: "light",
  fontFamily: "system-ui",
  fontSize: 28,
  wpm: 600,
  sentencePauseMs: 150,
  paragraphPauseMs: 200,
  pacingModel: "naive",
  bayesianGamma: 0.98,
};

/** Merge per-reader overrides onto global settings → effective settings. */
export function mergeSettings(global: GlobalSettings, local?: ReaderSettings): GlobalSettings {
  if (!local) return global;
  return { ...global, ...local };
}
