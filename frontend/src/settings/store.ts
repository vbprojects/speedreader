// src/settings/store.ts
// Settings store: holds global + per-reader settings, persists to localStorage
// (client-side, offline-first). Subscribers get notified on change.
// Also persists per-book reading positions (separate storage key).

import { DEFAULT_GLOBAL_SETTINGS, mergeSettings } from "./types";
import type { GlobalSettings, ReaderPosition, ReaderSettings, SettingsState } from "./types";

const STORAGE_KEY = "speedreader.settings.v1";
const POSITIONS_KEY = "speedreader.positions.v1";

type Listener = (state: SettingsState) => void;

export class SettingsStore {
  private state: SettingsState;
  private positions: Record<string, ReaderPosition>;
  private listeners = new Set<Listener>();

  constructor(initial?: Partial<SettingsState>) {
    this.state = this.load();
    this.positions = this.loadPositions();
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

  /** Saved reading position for a book, or null if never read. */
  getPosition(bookId: string): ReaderPosition | null {
    return this.positions[bookId] ?? null;
  }

  /** Save a reading position for a book. */
  setPosition(bookId: string, index: number): void {
    this.positions = {
      ...this.positions,
      [bookId]: { index, updatedAt: Date.now() },
    };
    this.persistPositions();
  }

  /** Forget a book's saved position. */
  clearPosition(bookId: string): void {
    const { [bookId]: _removed, ...rest } = this.positions;
    this.positions = rest;
    this.persistPositions();
  }

  /** All saved positions (for a "continue reading" list). */
  allPositions(): Record<string, ReaderPosition> {
    return { ...this.positions };
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

  private loadPositions(): Record<string, ReaderPosition> {
    try {
      const raw = localStorage.getItem(POSITIONS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as { positions?: Record<string, ReaderPosition> };
      return parsed.positions ?? {};
    } catch {
      return {};
    }
  }

  private persistPositions(): void {
    try {
      localStorage.setItem(POSITIONS_KEY, JSON.stringify({ positions: this.positions }));
    } catch {
      // Storage unavailable — positions just won't persist.
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