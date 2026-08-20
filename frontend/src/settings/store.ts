// src/settings/store.ts
// Settings store: holds global + per-reader settings, persists to localStorage
// (client-side, offline-first). Subscribers get notified on change.

import { DEFAULT_GLOBAL_SETTINGS, mergeSettings } from "./types";
import type { GlobalSettings, ReaderSettings, SettingsState } from "./types";

const STORAGE_KEY = "speedreader.settings.v1";

type Listener = (state: SettingsState) => void;

export class SettingsStore {
  private state: SettingsState;
  private listeners = new Set<Listener>();

  constructor(initial?: Partial<SettingsState>) {
    this.state = this.load();
    if (initial) {
      this.state = {
        global: { ...this.state.global, ...initial.global },
        perReader: { ...this.state.perReader, ...initial.perReader },
      };
    }
  }

  get global(): GlobalSettings {
    return this.state.global;
  }

  /** Effective settings for a reader (global + per-reader overrides). */
  forReader(bookId: string): GlobalSettings {
    return mergeSettings(this.state.global, this.state.perReader[bookId]);
  }

  /** Update global settings (partial). */
  updateGlobal(patch: Partial<GlobalSettings>): void {
    this.state = { ...this.state, global: { ...this.state.global, ...patch } };
    this.persist();
    this.emit();
  }

  /** Update per-reader settings (partial). */
  updateReader(bookId: string, patch: ReaderSettings): void {
    this.state = {
      ...this.state,
      perReader: {
        ...this.state.perReader,
        [bookId]: { ...this.state.perReader[bookId], ...patch },
      },
    };
    this.persist();
    this.emit();
  }

  /** Reset a reader's overrides back to global. */
  resetReader(bookId: string): void {
    const { [bookId]: _removed, ...rest } = this.state.perReader;
    this.state = { ...this.state, perReader: rest };
    this.persist();
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private load(): SettingsState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { global: { ...DEFAULT_GLOBAL_SETTINGS }, perReader: {} };
      const parsed = JSON.parse(raw) as Partial<SettingsState>;
      return {
        global: { ...DEFAULT_GLOBAL_SETTINGS, ...parsed.global },
        perReader: parsed.perReader ?? {},
      };
    } catch {
      return { global: { ...DEFAULT_GLOBAL_SETTINGS }, perReader: {} };
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Storage unavailable (private mode, etc.) — settings just won't persist.
    }
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }
}