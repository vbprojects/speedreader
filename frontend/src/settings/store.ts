// src/settings/store.ts
// Settings store: holds GLOBAL settings only, persisted to localStorage
// (small, synchronous — needed at startup before the db is ready).
// Per-book reader settings + positions live in IndexedDB (see db/ + library/),
// keyed by the stable SHA-256 book id.

import { DEFAULT_GLOBAL_SETTINGS } from "./types";
import type { GlobalSettings, SettingsState } from "./types";

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
      };
    }
  }

  get global(): GlobalSettings {
    return this.state.global;
  }

  /** Update global settings (partial). */
  updateGlobal(patch: Partial<GlobalSettings>): void {
    this.state = { ...this.state, global: { ...this.state.global, ...patch } };
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
      if (!raw) return { global: { ...DEFAULT_GLOBAL_SETTINGS } };
      const parsed = JSON.parse(raw) as Partial<SettingsState>;
      return {
        global: { ...DEFAULT_GLOBAL_SETTINGS, ...parsed.global },
      };
    } catch {
      return { global: { ...DEFAULT_GLOBAL_SETTINGS } };
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