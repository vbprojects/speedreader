// src/settings/SettingsModal.tsx
// Glassmorphism settings modal: centered on screen, click-outside to close.
// Reusable for both global (library) and per-reader settings.

import { lazy, Suspense, useEffect } from "react";
import type { GlobalSettings, ReaderSettings, Theme } from "./types";
import { themeTokens } from "./themes";
import { SettingsPanel } from "./SettingsPanel";

const VoiceDownloads = lazy(() => import("../audio/VoiceDownloads"));

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: GlobalSettings;
  isReader?: boolean;
  audioActive?: boolean;
  audioSettings?: React.ReactNode;
  readingExperience?: React.ReactNode;
  onChange: (patch: ReaderSettings) => void;
  onReset?: () => void;
  theme: Theme;
}

export function SettingsModal({ open, onClose, settings, isReader, audioActive, audioSettings, readingExperience, onChange, onReset, theme }: SettingsModalProps) {
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
          width: "100%",
          maxWidth: "min(94vw, 520px)",
          maxHeight: "88vh",
          overflowY: "auto",
          overflowX: "hidden",
          borderRadius: 20,
          border: `1px solid ${t.border}`,
          background: `${t.panel}e6`, // panel color at ~90% alpha
          backdropFilter: "blur(24px) saturate(1.4)",
          WebkitBackdropFilter: "blur(24px) saturate(1.4)",
          boxShadow: "0 8px 40px rgba(0,0,0,0.25)",
          color: t.fg,
        }}
      >
        {readingExperience}
        <SettingsPanel downloads={audioSettings ?? (!isReader ? <Suspense fallback={<p>Loading speech settings…</p>}><VoiceDownloads settings={settings} onChange={onChange} /></Suspense> : undefined)} settings={settings} isReader={isReader} audioActive={audioActive} onChange={onChange} onReset={onReset} />
      </div>
    </div>
  );
}
