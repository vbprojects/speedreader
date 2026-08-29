// src/settings/themes.ts
// Shared theme tokens used across the app (reader, menus, library, nav tree).
// Single source of truth so every surface stays consistent per theme.

import type { Theme } from "./types";

export interface ThemeTokens {
  /** Page/background color. */
  bg: string;
  /** Primary text color. */
  fg: string;
  /** Muted/secondary text (context words, labels). */
  muted: string;
  /** Highlight color for the current word. */
  highlight: string;
  /** Highlight text color (on top of highlight). */
  highlightFg: string;
  /** Panel/surface background (menus, settings, nav). */
  panel: string;
  /** Panel border. */
  border: string;
  /** Hover background for interactive rows. */
  hover: string;
  /** Active/selected row background. */
  active: string;
  /** Active row text color. */
  activeFg: string;
  /** Destructive/error text color. */
  danger: string;
  /** Subtle error message background. */
  dangerBg: string;
}

export const THEMES: Record<Theme, ThemeTokens> = {
  light: {
    bg: "#ffffff",
    fg: "#111111",
    muted: "#666666",
    highlight: "#2563eb",
    highlightFg: "#ffffff",
    panel: "#f7f7f7",
    border: "#d0d0d0",
    hover: "#e5e7eb",
    active: "#2563eb",
    activeFg: "#ffffff",
    danger: "#b42318",
    dangerBg: "#fef3f2",
  },
  dark: {
    bg: "#1e1e1e",
    fg: "#e0e0e0",
    muted: "#a3a3a3",
    highlight: "#3b82f6",
    highlightFg: "#ffffff",
    panel: "#2a2a2a",
    border: "#444444",
    hover: "#333333",
    active: "#3b82f6",
    activeFg: "#ffffff",
    danger: "#fda29b",
    dangerBg: "#3b1414",
  },
  sepia: {
    bg: "#f4ecd8",
    fg: "#5b4636",
    muted: "#75624f",
    highlight: "#c0392b",
    highlightFg: "#ffffff",
    panel: "#efe6d0",
    border: "#d8c9a8",
    hover: "#e8dcc0",
    active: "#c0392b",
    activeFg: "#ffffff",
    danger: "#9b2c2c",
    dangerBg: "#f8e4d8",
  },
  "high-contrast": {
    bg: "#000000",
    fg: "#ffffff",
    muted: "#cccccc",
    highlight: "#ffff00",
    highlightFg: "#000000",
    panel: "#111111",
    border: "#ffffff",
    hover: "#222222",
    active: "#ffff00",
    activeFg: "#000000",
    danger: "#ff8a8a",
    dangerBg: "#220000",
  },
};

export function themeTokens(theme: Theme): ThemeTokens {
  return THEMES[theme] ?? THEMES.light;
}
