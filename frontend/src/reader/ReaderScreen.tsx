// src/reader/ReaderScreen.tsx
// The reader view for one book: top bar, settings modal, and SpeedReader.
// Receives the already-hydrated stream + effective settings + initial index,
// and reports position/settings changes up so the coordinator can persist.

import { useMemo, useState } from "react";
import type { WordStream } from "../epub/types";
import { PacingEngine, selectBackend } from "../pacing";
import { SpeedReader } from "../display";
import { SettingsModal, themeTokens } from "../settings";
import type { GlobalSettings, ReaderSettings } from "../settings";

export interface ReaderScreenProps {
  stream: WordStream;
  title: string;
  /** Effective settings (global merged with per-book overrides). */
  settings: GlobalSettings;
  /** Word index to start at (saved position). */
  initialIndex: number;
  onBack: () => void;
  /** Called on every position change (coordinator debounces + persists). */
  onPositionChange: (index: number) => void;
  /** Called when per-book settings change. */
  onSettingsChange: (patch: ReaderSettings) => void;
  /** Called to reset per-book settings to global. */
  onSettingsReset: () => void;
}

export function ReaderScreen({ stream, title, settings, initialIndex, onBack, onPositionChange, onSettingsChange, onSettingsReset }: ReaderScreenProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const t = themeTokens(settings.theme);

  // Pacing engine recreated when effective WPM/pauses/model/gamma change.
  const pacing = useMemo(
    () =>
      new PacingEngine({
        backend: selectBackend(settings.pacingModel ?? "naive", { gamma: settings.bayesianGamma ?? 0.98 }),
        profile: {
          wpm: settings.wpm,
          sentencePauseMs: settings.sentencePauseMs,
          paragraphPauseMs: settings.paragraphPauseMs,
          gamma: settings.bayesianGamma ?? 0.98,
        },
      }),
    [settings.pacingModel, settings.bayesianGamma, settings.wpm, settings.sentencePauseMs, settings.paragraphPauseMs]
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <div
        style={{
          fontFamily: settings.fontFamily,
          padding: "8px 16px",
          display: "flex",
          gap: 12,
          alignItems: "center",
          borderBottom: `1px solid ${t.border}`,
          background: t.panel,
          color: t.fg,
          flexShrink: 0,
        }}
      >
        <button onClick={onBack}>← Library</button>
        <span style={{ fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </span>
        <span style={{ color: t.muted, fontSize: 13 }} className="word-count">
          {stream.meta.totalWords.toLocaleString()} words · {stream.chapterIndex.length} chapters
        </span>
        <button onClick={() => setShowSettings(true)}>Settings</button>
      </div>

      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        isReader
        onChange={onSettingsChange}
        onReset={onSettingsReset}
        theme={settings.theme}
      />

      <div style={{ flex: 1, minHeight: 0 }}>
        <SpeedReader
          stream={stream}
          pacing={pacing}
          config={{ wpm: settings.wpm }}
          fontFamily={settings.fontFamily}
          fontSize={settings.fontSize}
          theme={settings.theme}
          navCollapsed={navCollapsed}
          onToggleNav={() => setNavCollapsed((c) => !c)}
          initialIndex={initialIndex}
          onPositionChange={onPositionChange}
        />
      </div>

      <style>{`
        @media (max-width: 640px) {
          .word-count { display: none !important; }
        }
      `}</style>
    </div>
  );
}