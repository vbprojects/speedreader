// src/reader/ReaderScreen.tsx
// The reader view for one book: top bar, settings modal, and SpeedReader.
// Receives the already-hydrated stream + effective settings + initial index,
// and reports position/settings changes up so the coordinator can persist.

import { useMemo, useState } from "react";
import type { WordStream } from "../epub/types";
import type { InteractionRecord, InteractionResponse } from "../interactions/types";
import type { ReaderEngineEvent } from "../engine-events/types";
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
  /** Completed blocking interaction IDs for this reader session. */
  initialCompletedInteractionIds?: string[];
  /** Called when an interaction is completed. */
  onInteractionResolved?: (interactionId: string) => void;
  initialInteractionRecords?: InteractionRecord[];
  onInteractionCommitted?: (record: InteractionRecord) => void;
  /** Optional format-owned interaction responder. */
  onInteractionSubmit?: (response: InteractionResponse) => Promise<void>;
  initialDeliveredTriggerIds?: string[];
  onEngineEvent?: (event: ReaderEngineEvent) => Promise<void> | void;
  liveError?: string | null;
}

export function ReaderScreen({ stream, title, settings, initialIndex, onBack, onPositionChange, onSettingsChange, onSettingsReset, initialCompletedInteractionIds, onInteractionResolved, initialInteractionRecords, onInteractionCommitted, onInteractionSubmit, initialDeliveredTriggerIds, onEngineEvent, liveError }: ReaderScreenProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(true);
  const [running, setRunning] = useState(false);
  const t = themeTokens(settings.theme);

  // Pacing engine recreated when effective WPM/pauses/model/gamma change.
  const pacing = useMemo(
    () =>
      new PacingEngine({
        backend: selectBackend(
          settings.pacingModel ?? "naive",
          settings.pacingModel === "bayesian" ? { gamma: settings.bayesianGamma ?? 0.98 } : undefined,
        ),
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
      {/* Top Header Bar: hidden while playing for an ultra-clean distraction-free reading experience */}
      <div
        style={{
          fontFamily: settings.fontFamily,
          padding: running ? "0 16px" : "8px 16px",
          maxHeight: running ? 0 : 56,
          opacity: running ? 0 : 1,
          overflow: "hidden",
          transition: "all 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
          display: "flex",
          gap: 12,
          alignItems: "center",
          borderBottom: running ? "none" : `1px solid ${t.border}`,
          background: t.panel,
          color: t.fg,
          flexShrink: 0,
          pointerEvents: running ? "none" : "auto",
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
        {stream.words.length === 0 ? (
          <div style={{ height: "100%", display: "grid", placeItems: "center", background: t.bg, color: t.muted, fontFamily: settings.fontFamily }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 18, color: t.fg, marginBottom: 8 }}>Listening to the live stream…</div>
              <div role={liveError ? "alert" : undefined} style={{ fontSize: 13, color: liveError ? t.highlight : undefined }}>
                {liveError ?? "Waiting for the first eligible English text post."}
              </div>
            </div>
          </div>
        ) : <SpeedReader
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
          onRunningChange={setRunning}
          initialCompletedInteractionIds={initialCompletedInteractionIds}
          onInteractionResolved={onInteractionResolved}
          initialInteractionRecords={initialInteractionRecords}
          onInteractionCommitted={onInteractionCommitted}
          onInteractionSubmit={onInteractionSubmit}
          initialDeliveredTriggerIds={initialDeliveredTriggerIds}
          onEngineEvent={onEngineEvent}
        />}
      </div>

      <style>{`
        @media (max-width: 640px) {
          .word-count { display: none !important; }
        }
      `}</style>
    </div>
  );
}
