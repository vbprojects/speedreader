// EpubExplorer.tsx
// Experiment 1 UI: pick an .epub file, run epubjs exploration, and display
// the resulting structure + flat word stream.

import { useRef, useState } from "react";
import { exploreEpub, toWordStream } from "./explore";
import type { EpubStructure, WordStream } from "./types";

export default function EpubExplorer() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [structure, setStructure] = useState<EpubStructure | null>(null);
  const [stream, setStream] = useState<WordStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setStructure(null);
    setStream(null);
    try {
      const data = await file.arrayBuffer();
      const s = await exploreEpub(data);
      setStructure(s);
      setStream(toWordStream(s));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1>EPUB Explorer (Experiment 1)</h1>

      <button onClick={() => inputRef.current?.click()}>
        {busy ? "Parsing..." : "Choose an .epub file"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".epub"
        style={{ display: "none" }}
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      {error && <p style={{ color: "red" }}>Error: {error}</p>}

      {structure && (
        <div>
          <h2>Book metadata</h2>
          <pre>{JSON.stringify(structure.metadata, null, 2)}</pre>

          <h2>Spine (reading order)</h2>
          <ul>
            {structure.spine.map((s) => (
              <li key={s.idref}>
                #{s.index} — {s.href} {s.idref}
              </li>
            ))}
          </ul>

          <h2>Navigation (TOC)</h2>
          <ul>
            {structure.navigation.map((n, i) => (
              <li key={i}>
                {n.label} → {n.href}
              </li>
            ))}
          </ul>

          <h2>Chapter word counts</h2>
          <ul>
            {structure.pages.map((p) => (
              <li key={p.chapterId}>
                Ch {p.chapterId}: {p.words.length} words
              </li>
            ))}
          </ul>
        </div>
      )}

      {stream && (
        <div>
          <h2>Word stream (Option B)</h2>
          <pre>
            totalWords: {stream.meta.totalWords}, avgWordLength:{" "}
            {stream.meta.avgWordLength.toFixed(2)}, chapters:{" "}
            {stream.chapterIndex.length}
          </pre>
          <h3>chapterIndex</h3>
          <pre>{JSON.stringify(stream.chapterIndex, null, 2)}</pre>
          <h3>First 100 words</h3>
          <pre>{JSON.stringify(stream.words.slice(0, 100), null, 2)}</pre>
        </div>
      )}
    </div>
  );
}