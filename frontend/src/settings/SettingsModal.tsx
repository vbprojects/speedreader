// src/settings/SettingsModal.tsx
// Glassmorphism settings modal: centered on screen, click-outside to close.
// Reusable for both global (library) and per-reader settings.

import { useEffect } from "react";
import type { GlobalSettings, ReaderSettings, Theme } from "./types";
import { themeTokens } from "./themes";
import { SettingsPanel } from "./SettingsPanel";

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: GlobalSettings;
  isReader?: boolean;
  onChange: (patch: ReaderSettings) => void;
  onReset?: () => void;
  theme: Theme;
}

export function SettingsModal({ open, onClose, settings, isReader, onChange, onReset, theme }: SettingsModalProps) {
  const t = themeTokens(theme);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }}
    >
      {/* Glass card — stopPropagation so clicking inside doesn't close.
          Background is theme-aware (panel color + alpha) so text stays
          readable on every theme. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass-scroll"
        style={{
          maxWidth: "min(92vw, 420px)",
          maxHeight: "85vh",
          overflowY: "auto",
          borderRadius: 20,
          border: `1px solid ${t.border}`,
          background: `${t.panel}e6`, // panel color at ~90% alpha
          backdropFilter: "blur(24px) saturate(1.4)",
          WebkitBackdropFilter: "blur(24px) saturate(1.4)",
          boxShadow: "0 8px 40px rgba(0,0,0,0.25)",
          color: t.fg,
        }}
      >
        <SettingsPanel settings={settings} isReader={isReader} onChange={onChange} onReset={onReset} />
      </div>
    </div>
  );
}