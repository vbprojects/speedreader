import { useEffect, useMemo, useRef, useState } from "react";
import type { Area, Snapshot } from "../ingestion/sugarcube/storage-protocol";
import { allRecoveryEntries, downloadRecovery, inspectRecoverySnapshot, readRecoveryFile, selectedRecovery, snapshotForReplacement, type RecoveryCandidate, type RecoverySelection } from "./storage-recovery";
import { formatBytes, readStorageStatus, requestStoragePersistence, type StorageStatus } from "./storage-status";

export interface PublishedStorageToolsProps {
  sourceHash: string;
  getStored: () => Promise<{ revision: string | null; snapshot: unknown }>;
  getLive?: () => Promise<Snapshot>;
  replaceStored: (snapshot: Snapshot, expectedRevision: string | null) => Promise<void>;
  getBudget: () => Promise<{ usedBytes: number; limitBytes: number; unaccountedStories?: number }>;
  onImported: () => void;
}
interface Preview { candidate: RecoveryCandidate; expected: string | null; label: "saved" | "imported" }
const PAGE_SIZE = 40;
const emptySelection = (): RecoverySelection => ({ local: new Set(), session: new Set() });

/** Parent freezes the running story before replaceStored and reloads onImported. */
export function PublishedStorageTools({ sourceHash, getStored, getLive, replaceStored, getBudget, onImported }: PublishedStorageToolsProps) {
  const [status, setStatus] = useState<StorageStatus>();
  const [budget, setBudget] = useState<Awaited<ReturnType<typeof getBudget>>>();
  const [preview, setPreview] = useState<Preview>();
  const [selection, setSelection] = useState(emptySelection);
  const [area, setArea] = useState<Area>("local");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false), operation = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const picked = useMemo(() => preview ? selectedRecovery(preview.candidate, selection) : undefined, [preview, selection]);
  async function run(action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "The storage action failed."); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  async function refresh() {
    const results = await Promise.allSettled([readStorageStatus(), Promise.resolve().then(getBudget)]);
    if (!mounted.current) return;
    if (results[0].status === "fulfilled") setStatus(results[0].value);
    if (results[1].status === "fulfilled") setBudget(results[1].value);
    else setError("Could not read the published-save budget. Existing saves are unchanged.");
  }
  function show(candidate: RecoveryCandidate, expected: string | null, label: Preview["label"]) {
    if (!mounted.current) return;
    setPreview({ candidate, expected, label }); setSelection(allRecoveryEntries(candidate)); setArea("local"); setPage(0);
  }
  const count = picked ? picked.entryCount.local + picked.entryCount.session : 0;
  return <details style={{ padding: ".4rem .75rem", borderBottom: "1px solid #8885", maxHeight: "55dvh", overflow: "auto" }} onToggle={event => {
    if (event.currentTarget.open && !status) void run(refresh);
  }}>
    <summary>Save storage and recovery</summary>
    <section aria-label="Device storage">
      <h2>Device storage</h2>
      {status && <>
        <p>Browser estimate for this site: {formatBytes(status.usage)} used, {formatBytes(status.remaining)} remaining
          {status.quota !== undefined ? ` of ${formatBytes(status.quota)}` : ""}. These are estimates; a save may still fail when the device is full.</p>
        <p>{status.persistence === "granted" ? "Persistent storage is enabled. Keep exported backups for device loss or cleared site data." : status.persistence === "unsupported" ? "This browser cannot report persistent-storage protection." : status.persistence === "unknown" ? "Persistent-storage protection could not be checked." : "The browser may remove this site's data under storage pressure. Export important saves."}</p>
        {status.problem && <p>{status.problem}</p>}
      </>}
      {budget && <p>Published saves across all stories: {formatBytes(budget.usedBytes)} of {formatBytes(budget.limitBytes)}.
        {budget.unaccountedStories ? ` ${budget.unaccountedStories} older save(s) need recovery before growth is allowed.` : ""}
        {budget.usedBytes > budget.limitBytes ? " The budget is exceeded; export and explicitly reduce saves to free space." : ""}
        {" "}No saves are removed automatically.</p>}
      <button disabled={busy} onClick={() => void run(refresh)}>Refresh storage</button>{" "}
      {status?.canRequestPersistence && status.persistence !== "granted" && <button disabled={busy} onClick={() => void run(async () => {
        const next = await requestStoragePersistence();
        if (mounted.current) { setStatus(next); setNotice(next.persistence === "granted" ? "Persistent storage enabled." : "The browser did not grant persistent storage. Your saves are unchanged; keep exported backups."); }
      })}>Protect offline saves</button>}
    </section>
    <section aria-label="Save recovery">
      <h2>Export or recover saves</h2>
      <p>Exports contain the exact saved strings for this story. Imports replace its published saves after review. Native-reader progress is kept separately.</p>
      <button disabled={busy} onClick={() => void run(async () => {
        const saved = await getStored();
        if (!mounted.current) return;
        downloadRecovery(inspectRecoverySnapshot(saved.snapshot, sourceHash), "saved");
        if (mounted.current) setNotice("Saved-data export downloaded.");
      })}>Export saved data</button>{" "}
      {getLive && <><button disabled={busy} onClick={() => void run(async () => {
        const snapshot = await getLive();
        if (!mounted.current) return;
        downloadRecovery(inspectRecoverySnapshot(snapshot, sourceHash), "session");
        if (mounted.current) setNotice("Session export downloaded. It may include progress that is not yet saved on this device.");
      })}>Export this session</button>{" "}</>}
      <button disabled={busy} onClick={() => void run(async () => {
        const saved = await getStored(); show(inspectRecoverySnapshot(saved.snapshot, sourceHash), saved.revision, "saved");
      })}>Review saved data</button>{" "}
      <label>Import save JSON <input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
        if (file) void run(async () => {
          const candidate = await readRecoveryFile(file, sourceHash);
          if (!mounted.current) return;
          const current = await getStored(); show(candidate, current.revision, "imported");
        });
      }} /></label>
      {preview && picked && <section aria-label="Recovery preview" style={{ marginTop: ".75rem", padding: ".5rem", border: "1px solid #8888" }}>
        <h3>Review {preview.label} data</h3>
        <p>{count} entries selected. Local: {formatBytes(picked.logicalBytes.local)}; session: {formatBytes(picked.logicalBytes.session)}.</p>
        <p>Storage entries can depend on one another. Removing an entry may remove save slots, settings, or history. Export the original first; select only entries you intend to keep.</p>
        {!picked.fitsRuntime && <p role="alert">Selection exceeds story limits: {picked.violations.join("; ")}. No data has been changed.</p>}
        <label>Storage area <select disabled={busy} value={area} onChange={event => { setArea(event.currentTarget.value as Area); setPage(0); }}>
          <option value="local">Local saves and settings</option><option value="session">Session and history</option>
        </select></label>{" "}
        <button disabled={busy} onClick={() => setSelection(old => ({ ...old, [area]: new Set(preview.candidate.snapshot[area].map((_, i) => i)) }))}>Select this area</button>{" "}
        <button disabled={busy} onClick={() => setSelection(old => ({ ...old, [area]: new Set<number>() }))}>Deselect this area</button>
        <table><thead><tr><th scope="col">Keep</th><th scope="col">Storage key</th><th scope="col">Logical size</th></tr></thead><tbody>
          {preview.candidate.snapshot[area].slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(([key, value], offset) => {
            const index = page * PAGE_SIZE + offset;
            const label = key.length > 100 ? JSON.stringify(key.slice(0, 100)) + "…" : JSON.stringify(key);
            return <tr key={index}>
              <td><input type="checkbox" aria-label={`Keep ${area} entry ${index + 1}`} disabled={busy} checked={selection[area].has(index)} onChange={() => setSelection(old => {
                const next = new Set(old[area]); if (next.has(index)) next.delete(index); else next.add(index); return { ...old, [area]: next };
              })} /></td><td style={{ overflowWrap: "anywhere" }}>{label}</td><td>{formatBytes(64 + 2 * (key.length + value.length))}</td>
            </tr>;
          })}
        </tbody></table>
        <button disabled={busy || page === 0} onClick={() => setPage(old => old - 1)}>Previous entries</button>{" "}
        <span>Page {page + 1} of {Math.max(1, Math.ceil(preview.candidate.snapshot[area].length / PAGE_SIZE))}</span>{" "}
        <button disabled={busy || (page + 1) * PAGE_SIZE >= preview.candidate.snapshot[area].length} onClick={() => setPage(old => old + 1)}>Next entries</button>
        <p><button disabled={busy} onClick={() => void run(async () => { downloadRecovery(picked, "selection"); })}>Export selection</button>{" "}
          <button disabled={busy || !picked.fitsRuntime} onClick={() => void run(async () => {
            const next = snapshotForReplacement(picked);
            if (!window.confirm(`Replace this story's published saves with these ${count} selected entries? Unselected data and unsaved progress in this session will be replaced. Export anything you want to keep first.`)) return;
            await replaceStored(next, preview.expected);
            if (!mounted.current) return;
            setPreview(undefined); setSelection(emptySelection()); setNotice("Selected data saved. Reopening the story…"); onImported();
          })}>Replace published saves</button>{" "}
          <button disabled={busy} onClick={() => setPreview(undefined)}>Cancel recovery</button></p>
      </section>}
    </section>
    {busy && <p role="status">Working with save data…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </details>;
}
