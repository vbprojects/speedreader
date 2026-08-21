// src/settings/types.ts
// Settings model: global (library-wide) + per-reader (local) settings.
// Per-reader settings override global ones for that reader instance.

export type Theme = "light" | "dark" | "sepia" | "high-contrast";

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
}

/** Per-reader settings — override global for one reader instance. */
export type ReaderSettings = Partial<GlobalSettings>;

/** The full settings state: global + per-reader overrides. */
export interface SettingsState {
  global: GlobalSettings;
  /** Keyed by book id (or stream id). */
  perReader: Record<string, ReaderSettings>;
}

/** A saved reading position for a book. */
export interface ReaderPosition {
  /** Word index in the stream. */
  index: number;
  /** When the position was last saved (epoch ms). */
  updatedAt: number;
}

/** The full reader-state map: book id → saved position. */
export interface ReaderStateMap {
  positions: Record<string, ReaderPosition>;
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  theme: "light",
  fontFamily: "system-ui",
  fontSize: 28,
  wpm: 600,
  sentencePauseMs: 150,
  paragraphPauseMs: 200,
};

/** Merge per-reader overrides onto global settings → effective settings. */
export function mergeSettings(global: GlobalSettings, local?: ReaderSettings): GlobalSettings {
  if (!local) return global;
  return { ...global, ...local };
}