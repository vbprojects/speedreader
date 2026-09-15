import { useEffect, useMemo, useRef, useState } from "react";
import type { ImportResult } from "./types";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";
import { availability, readingMinutes, streamText } from "./reading-info";

interface Props {
  result?: ImportResult;
  theme: Theme;
  wpm: number;
  busy: boolean;
  onClose: () => void;
  onRead: (bookId: string) => void;
  onSaveText: (text: string, title: string) => Promise<void>;
  onChooseFile: () => void;
}

/** Native modal supplies focus trapping, Escape handling, and focus restoration. */
export function ImportDialog({ result, theme, wpm, busy, onClose, onRead, onSaveText, onChooseFile }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const t = themeTokens(theme);
  const editable = !result || (result.stream.meta.isComplete !== false
    && !result.stream.interactions?.length && !result.stream.triggers?.length && !result.stream.presentations?.length
    && result.stream.words.length <= 30_000);
  const original = useMemo(() => result && editable ? streamText(result.stream) : "", [result, editable]);
  const [text, setText] = useState(original);
  const [title, setTitle] = useState(result?.book.title ?? "Pasted text");
  const [editing, setEditing] = useState(!result);
  const [error, setError] = useState<string | null>(null);
  const confirmDiscard = () => !editing || (text === original && title === (result?.book.title ?? "Pasted text"))
    || window.confirm("Discard your unsaved text changes?");
  const close = () => { if (!busy && confirmDiscard()) onClose(); };
  const unavailable = result?.book.format === "sugarcube-2-runtime";

  useEffect(() => { dialog.current?.showModal(); }, []);

  const save = async () => {
    setError(null);
    try { await onSaveText(text, title); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const preview = result ? streamText({ ...result.stream, words: result.stream.words.slice(0, 120) }).split("\n\n")[0] : "";

  return <dialog ref={dialog} className="import-dialog" aria-labelledby="import-title"
    onCancel={(event) => { event.preventDefault(); close(); }}
    style={{ background: t.panel, color: t.fg, borderColor: t.border }}>
    <h2 id="import-title">{result ? "Preview import" : "Paste text"}</h2>
    {result && <>
      <h3>{result.book.title}</h3>
      <p>{result.existed ? "Already in your library." : "Saved to your library."} {availability(result.book)}.</p>
      {result.stream.words.length > 0 && <p>{result.stream.words.length.toLocaleString()} words · About {readingMinutes(result.stream.words.length, wpm)} min at {wpm} WPM</p>}
      {result.book.ingestionWarnings?.map((warning) => <p key={warning} role="status">{warning}</p>)}
      {unavailable ? <p>This story is saved, but its interactive reader engine is not available in this version. You can import another file or paste a passage as text.</p>
        : !editing && <p className="import-excerpt">{preview || "No readable text is available yet. Live sources require a connection to load new content."}{result.stream.words.length > 120 ? "…" : ""}</p>}
      {!editing && editable && <button onClick={() => setEditing(true)}>Clean up text</button>}
    </>}
    {editing && <>
      {result && <p>Save a cleaned copy with its own reading position. The original stays in your library.</p>}
      <label>Title<input value={title} maxLength={200} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Text<textarea value={text} maxLength={500_000} disabled={busy} rows={10} onChange={(event) => setText(event.target.value)} autoFocus={!result} /></label>
    </>}
    {error && <p role="alert">{error}</p>}
    <div className="import-actions">
      <button onClick={close} disabled={busy}>{result ? "Back to library" : "Cancel"}</button>
      {result && <button onClick={() => { if (confirmDiscard()) onChooseFile(); }} disabled={busy}>Choose another file</button>}
      {editing ? <button disabled={busy || !text.trim()} onClick={() => void save()}>{busy ? "Saving…" : result ? "Save cleaned copy" : "Preview text"}</button>
        : result && <button autoFocus disabled={busy || unavailable || !result.stream.words.length} onClick={() => onRead(result.book.id)}>Start reading</button>}
    </div>
  </dialog>;
}
