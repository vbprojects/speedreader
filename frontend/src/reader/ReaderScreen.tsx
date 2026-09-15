// src/reader/ReaderScreen.tsx
// The reader view for one book: top bar, settings modal, and SpeedReader.
// Receives the already-hydrated stream + effective settings + initial index,
// and reports position/settings changes up so the coordinator can persist.

import { useCallback, useMemo, useRef, useState } from "react";
import type { WordStream } from "../epub/types";
import type { InteractionRecord, InteractionResponse } from "../interactions/types";
import type { ReaderEngineEvent } from "../engine-events/types";
import { createPacingEngine } from "../pacing";
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
  sourceFormat?: string;
  offline?: boolean;
  onPause?: () => void;
  onRetry?: () => void;
}

export function ReaderScreen({ stream, title, settings, initialIndex, onBack, onPositionChange, onSettingsChange, onSettingsReset, initialCompletedInteractionIds, onInteractionResolved, initialInteractionRecords, onInteractionCommitted, onInteractionSubmit, initialDeliveredTriggerIds, onEngineEvent, liveError, sourceFormat, offline, onPause, onRetry }: ReaderScreenProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(true);
  const [running, setRunning] = useState(false);
  const t = themeTokens(settings.theme);
  const wasRunning = useRef(false);
  const handleRunning = useCallback((next: boolean) => {
    if (wasRunning.current && !next) onPause?.();
    wasRunning.current = next;
    setRunning(next);
  }, [onPause]);
  const requiresConnection = sourceFormat === "bluesky-jetstream" || sourceFormat === "openai-compatible-llm";
  const unavailable = sourceFormat === "sugarcube-2-runtime";

  // Pacing engine recreated when effective WPM/pauses/model/gamma change.
  const pacing = useMemo(
    () => createPacingEngine(settings),
    [
      settings.pacingModel,
      settings.bayesianGamma,
      settings.surprisalNGramSize,
      settings.surprisalSensitivity,
      settings.wpm,
      settings.sentencePauseMs,
      settings.paragraphPauseMs,
    ]
  );

  return (
    <div className="reader-screen" style={{ display: "flex", flexDirection: "column", height: "100dvh", overflow: "hidden" }}>
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

      {(liveError || (offline && requiresConnection)) && <div role={liveError ? "alert" : "status"} className="reader-status" style={{ background: t.panel, color: t.fg }}>
        <span>{liveError ?? "You’re offline. Saved content is readable; reconnect to load more."}</span>
        {liveError && requiresConnection && !offline && !liveError.startsWith("Could not save your place:") && <button onClick={onRetry}>Retry connection</button>}
        {liveError?.startsWith("Could not save your place:") && <button onClick={onPause}>Retry saving progress</button>}
      </div>}
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
              <div style={{ fontSize: 18, color: t.fg, marginBottom: 8 }}>{unavailable ? "Reader engine unavailable" : offline ? "You’re offline" : requiresConnection ? "Waiting for content…" : "No readable text"}</div>
              <div role={liveError ? "alert" : undefined} style={{ fontSize: 13, color: liveError ? t.highlight : undefined }}>
                {liveError ?? (unavailable ? "This story is saved, but its interactive reader engine is not available in this version." : offline ? "Reconnect to load new content, or return to the library to read a saved book." : sourceFormat === "bluesky-jetstream" ? "Waiting for the first eligible English text post." : "Return to the library and try importing a file with readable text.")}
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
          initialViewMode={settings.viewMode}
          onViewModeChange={(viewMode) => onSettingsChange({ viewMode })}
          navCollapsed={navCollapsed}
          onToggleNav={() => setNavCollapsed((c) => !c)}
          initialIndex={initialIndex}
          onPositionChange={onPositionChange}
          onNavigate={onPause}
          onRunningChange={handleRunning}
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
