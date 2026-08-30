import { useEffect, useMemo, useState } from "react";
import type {
  ForeignImportPlan,
  ForeignItem,
  ForeignLibraryRegistry,
  ForeignLibrarySession,
} from "../foreign-libraries";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";

export function ForeignLibraryDialog({
  open,
  theme,
  registry,
  onImport,
  onClose,
}: {
  open: boolean;
  theme: Theme;
  registry: ForeignLibraryRegistry;
  onImport: (plan: ForeignImportPlan) => Promise<void>;
  onClose: () => void;
}) {
  const manifests = useMemo(() => registry.manifests, [registry]);
  const [libraryId, setLibraryId] = useState(manifests[0]?.id ?? "");
  const [session, setSession] = useState<ForeignLibrarySession | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ForeignItem[]>([]);
  const [selected, setSelected] = useState<ForeignItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = themeTokens(theme);

  useEffect(() => {
    if (!open || !libraryId) return;
    let active = true;
    let opened: ForeignLibrarySession | null = null;
    setSession(null);
    setItems([]);
    setSelected(null);
    setError(null);
    void registry.open(libraryId).then((value) => {
      opened = value;
      if (active) setSession(value);
      else void value.dispose();
    }).catch((openError: unknown) => {
      if (active) setError(openError instanceof Error ? openError.message : String(openError));
    });
    return () => {
      active = false;
      if (opened) void opened.dispose();
    };
  }, [libraryId, open, registry]);

  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [busy, onClose, open]);

  if (!open) return null;
  const control: React.CSSProperties = {
    minHeight: 44,
    boxSizing: "border-box",
    padding: "10px 12px",
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.bg,
    color: t.fg,
    font: "inherit",
  };

  const search = async () => {
    if (!session?.search || busy) return;
    setBusy(true);
    setError(null);
    setSelected(null);
    try {
      const page = await session.search({ query, pageSize: 25 });
      setItems(page.items);
      if (page.items.length === 0) setError("No matching items were found.");
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : String(searchError));
    } finally {
      setBusy(false);
    }
  };

  const inspect = async (item: ForeignItem) => {
    if (!session || busy) return;
    setBusy(true);
    setError(null);
    try {
      setSelected(await session.resolve(item.ref));
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : String(resolveError));
    } finally {
      setBusy(false);
    }
  };

  const importOffer = async (offerId: string) => {
    if (!session || !selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const plan = await session.planImport(selected.ref, offerId);
      await onImport(plan);
      onClose();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="presentation"
      onClick={() => { if (!busy) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 3000, display: "grid", placeItems: "center", padding: 16, background: "rgba(0,0,0,0.52)" }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="foreign-library-title"
        onClick={(event) => event.stopPropagation()}
        style={{ width: "min(760px, 100%)", maxHeight: "calc(100vh - 32px)", overflow: "auto", boxSizing: "border-box", padding: 22, border: `1px solid ${t.border}`, borderRadius: 14, background: t.panel, color: t.fg, fontFamily: "system-ui", boxShadow: "0 18px 60px rgba(0,0,0,0.32)" }}
      >
        <div style={{ display: "flex", alignItems: "start", gap: 16, marginBottom: 18 }}>
          <div style={{ flex: 1 }}>
            <h2 id="foreign-library-title" style={{ margin: "0 0 6px", fontSize: 21 }}>Find external content</h2>
            <p style={{ margin: 0, color: t.muted, fontSize: 14, lineHeight: 1.45 }}>Search a registered Foreign Library, review its available formats, then import through Speedreader’s normal parser.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" style={{ ...control, width: 44, padding: 0 }}>×</button>
        </div>

        {manifests.length > 1 && (
          <label style={{ display: "grid", gap: 6, marginBottom: 14, fontSize: 13 }}>
            Source
            <select value={libraryId} disabled={busy} onChange={(event) => setLibraryId(event.target.value)} style={control}>
              {manifests.map((manifest) => <option key={manifest.id} value={manifest.id}>{manifest.name}</option>)}
            </select>
          </label>
        )}

        <form onSubmit={(event) => { event.preventDefault(); void search(); }} style={{ display: "flex", gap: 10, alignItems: "end" }}>
          <label style={{ display: "grid", gap: 6, flex: 1, fontSize: 13 }}>
            Search {registry.manifest(libraryId).name}
            <input autoFocus value={query} disabled={busy || !session} onChange={(event) => setQuery(event.target.value)} placeholder="Title or author" style={{ ...control, width: "100%" }} />
          </label>
          <button type="submit" disabled={busy || !session || !query.trim()} style={{ ...control, border: 0, minWidth: 96, background: t.highlight, color: t.highlightFg, fontWeight: 650 }}>{busy ? "Working…" : "Search"}</button>
        </form>

        {error && <p role="alert" style={{ margin: "14px 0 0", padding: "10px 12px", borderRadius: 8, color: t.danger, background: t.dangerBg, fontSize: 14 }}>{error}</p>}

        {selected ? (
          <div style={{ marginTop: 20, paddingTop: 18, borderTop: `1px solid ${t.border}` }}>
            <button type="button" disabled={busy} onClick={() => setSelected(null)} style={{ border: 0, padding: 0, background: "transparent", color: t.highlight, font: "inherit", cursor: "pointer" }}>← Results</button>
            <h3 style={{ margin: "14px 0 5px", fontSize: 19 }}>{selected.title}</h3>
            <p style={{ margin: "0 0 8px", color: t.muted }}>{selected.authors?.join(", ") || "Unknown author"}</p>
            {selected.summary && <p style={{ lineHeight: 1.55, fontSize: 14 }}>{selected.summary}</p>}
            {selected.license?.name && <p style={{ color: t.muted, fontSize: 13 }}>Rights: {selected.license.name}</p>}
            <div style={{ display: "grid", gap: 9, marginTop: 16 }}>
              {selected.offers.map((offer) => (
                <button key={offer.id} type="button" disabled={busy} onClick={() => { void importOffer(offer.id); }} style={{ ...control, display: "flex", justifyContent: "space-between", textAlign: "left", cursor: busy ? "wait" : "pointer" }}>
                  <span>{offer.label}</span>
                  <span style={{ color: t.muted }}>{offer.byteLength ? `${(offer.byteLength / 1024 / 1024).toFixed(1)} MB` : offer.extension?.toUpperCase()}</span>
                </button>
              ))}
            </div>
          </div>
        ) : items.length > 0 ? (
          <div role="list" style={{ display: "grid", gap: 8, marginTop: 20 }}>
            {items.map((item) => (
              <button key={`${item.ref.libraryId}:${item.ref.itemId}`} role="listitem" type="button" disabled={busy} onClick={() => { void inspect(item); }} style={{ ...control, height: "auto", display: "grid", gap: 3, textAlign: "left", cursor: busy ? "wait" : "pointer" }}>
                <strong>{item.title}</strong>
                <span style={{ color: t.muted, fontSize: 13 }}>{item.authors?.join(", ") || "Unknown author"}</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
