// src/ReaderApp.tsx
// Wires the full pipeline: pick file → IngestionEngine → PacingEngine → SpeedReader.
// Uses a SettingsStore: global settings for the library view, per-reader
// settings for each reader instance. A settings panel is available in both.

import { useEffect, useMemo, useState } from "react";
import { IngestionEngine, EpubParser, pickFileBrowser } from "./ingestion";
import type { WordStream } from "./ingestion";
import { PacingEngine, naiveBackend } from "./pacing";
import { SpeedReader } from "./display";
import { SettingsStore, SettingsModal, themeTokens } from "./settings";
import type { GlobalSettings } from "./settings";

export default function ReaderApp() {
  const [stream, setStream] = useState<WordStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);

  // Settings store (persists to localStorage).
  const [store] = useState(() => new SettingsStore());
  const [global, setGlobal] = useState<GlobalSettings>(() => store.global);
  const [readerSettings, setReaderSettings] = useState<GlobalSettings | null>(null);

  // Book id for per-reader settings (use the stream identity).
  const bookId = stream ? `book-${stream.meta.totalWords}-${stream.chapterIndex.length}` : null;

  // Subscribe to store changes.
  useEffect(() => {
    return store.subscribe(() => {
      setGlobal(store.global);
      if (bookId) setReaderSettings(store.forReader(bookId));
    });
  }, [store, bookId]);

  // One engine instance for the app.
  const engine = useMemo(() => new IngestionEngine([new EpubParser()]), []);

  // Effective settings for the current reader (global + per-reader overrides).
  const effective = bookId ? store.forReader(bookId) : global;

  // Pacing engine recreated when effective WPM/pauses change.
  const pacing = useMemo(
    () =>
      new PacingEngine({
        backend: naiveBackend,
        profile: {
          wpm: effective.wpm,
          sentencePauseMs: effective.sentencePauseMs,
          paragraphPauseMs: effective.paragraphPauseMs,
        },
      }),
    [effective.wpm, effective.sentencePauseMs, effective.paragraphPauseMs]
  );

  async function handlePick() {
    setBusy(true);
    setError(null);
    try {
      const file = await pickFileBrowser(".epub");
      if (!file) return;
      const s = await engine.ingest(file);
      setStream(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ---- Library view (no book open) ----
  if (!stream) {
    const t = themeTokens(global.theme);
    return (
      <div style={{ fontFamily: global.fontFamily, textAlign: "center", padding: 48, background: t.bg, color: t.fg, minHeight: "100vh" }}>
        <h1>Speedreader</h1>
        <button onClick={handlePick} disabled={busy}>
          {busy ? "Parsing..." : "Open an EPUB"}
        </button>
        <button onClick={() => setShowSettings((s) => !s)} style={{ marginLeft: 8 }}>
          Settings
        </button>
        {error && <p style={{ color: "red" }}>{error}</p>}

        <SettingsModal
          open={showSettings}
          onClose={() => setShowSettings(false)}
          settings={global}
          onChange={(patch) => store.updateGlobal(patch)}
          theme={global.theme}
        />
      </div>
    );
  }

  // ---- Reader view ----
  const t = themeTokens(global.theme);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <div style={{ fontFamily: global.fontFamily, padding: "8px 16px", display: "flex", gap: 12, alignItems: "center", borderBottom: `1px solid ${t.border}`, background: t.panel, color: t.fg, flexShrink: 0 }}>
        <button onClick={() => setStream(null)}>← Library</button>
        <span style={{ fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {stream.chapterIndex[0]?.title ?? "Book"}
        </span>
        <span style={{ color: t.muted, fontSize: 13 }} className="word-count">
          {stream.meta.totalWords.toLocaleString()} words · {stream.chapterIndex.length} chapters
        </span>
        <button onClick={() => setShowSettings(true)}>Settings</button>
      </div>

      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        settings={readerSettings ?? effective}
        isReader
        onChange={(patch) => bookId && store.updateReader(bookId, patch)}
        onReset={() => bookId && store.resetReader(bookId)}
        theme={effective.theme}
      />

      <div style={{ flex: 1, minHeight: 0 }}>
        <SpeedReader
          stream={stream}
          pacing={pacing}
          config={{ wpm: effective.wpm }}
          fontFamily={effective.fontFamily}
          fontSize={effective.fontSize}
          theme={effective.theme}
          navCollapsed={navCollapsed}
          onToggleNav={() => setNavCollapsed((c) => !c)}
          initialIndex={bookId ? (store.getPosition(bookId)?.index ?? 0) : 0}
          onPositionChange={(index) => bookId && store.setPosition(bookId, index)}
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