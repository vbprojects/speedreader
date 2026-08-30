import { useEffect, useMemo, useState } from "react";
import type {
  ForeignDownloadPlan,
  ForeignImportPlan,
  ForeignItem,
  ForeignLibraryManifest,
  ForeignLibraryRegistry,
  ForeignLibrarySession,
  ForeignOutputType,
} from "../foreign-libraries";
import { filterForeignLibraries, foreignOutputFilters, manualForeignDownload, type ManualForeignDownload } from "../foreign-libraries";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";

function libraryOutputLabel(manifest: ForeignLibraryManifest, type: ForeignOutputType): string {
  return manifest.outputs.find((output) => output.type === type)?.label ?? type;
}

export function ForeignLibraryDialog({
  open,
  theme,
  registry,
  onImport,
  onImportManual,
  onClose,
}: {
  open: boolean;
  theme: Theme;
  registry: ForeignLibraryRegistry;
  onImport: (plan: ForeignImportPlan) => Promise<void>;
  onImportManual?: (plan: ForeignDownloadPlan) => Promise<boolean>;
  onClose: () => void;
}) {
  const manifests = useMemo(() => registry.manifests, [registry]);
  const outputFilters = useMemo(() => foreignOutputFilters(manifests), [manifests]);
  const [outputFilter, setOutputFilter] = useState<ForeignOutputType | "all">("all");
  const filteredManifests = useMemo(
    () => filterForeignLibraries(manifests, outputFilter),
    [manifests, outputFilter],
  );
  const [libraryId, setLibraryId] = useState("");
  const [session, setSession] = useState<ForeignLibrarySession | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ForeignItem[]>([]);
  const [selected, setSelected] = useState<ForeignItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualDownload, setManualDownload] = useState<ManualForeignDownload | null>(null);
  const t = themeTokens(theme);
  const activeManifest = libraryId ? registry.manifest(libraryId) : null;

  useEffect(() => {
    if (open) return;
    setLibraryId("");
    setSession(null);
    setItems([]);
    setSelected(null);
    setError(null);
    setManualDownload(null);
  }, [open]);

  useEffect(() => {
    if (!open || !libraryId) return;
    let active = true;
    let opened: ForeignLibrarySession | null = null;
    setSession(null);
    setItems([]);
    setSelected(null);
    setError(null);
    setManualDownload(null);
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
    setManualDownload(null);
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
    setManualDownload(null);
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
    setManualDownload(null);
    try {
      const plan = await session.planImport(selected.ref, offerId);
      if (plan.kind === "download" && plan.acquisition === "manual") {
        const fallback = manualForeignDownload(plan, registry);
        if (!fallback) throw new Error("The library returned an invalid manual download.");
        setManualDownload(fallback);
        return;
      }
      try {
        await onImport(plan);
        onClose();
      } catch (importError) {
        setManualDownload(manualForeignDownload(plan, registry, importError));
        throw importError;
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setBusy(false);
    }
  };

  const importManualDownload = async () => {
    if (!manualDownload || !onImportManual || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (await onImportManual(manualDownload.plan)) onClose();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setBusy(false);
    }
  };

  const chooseLibrary = (manifest: ForeignLibraryManifest) => {
    setQuery("");
    setItems([]);
    setSelected(null);
    setError(null);
    setManualDownload(null);
    setLibraryId(manifest.id);
  };

  const showLibraries = () => {
    setLibraryId("");
    setQuery("");
    setItems([]);
    setSelected(null);
    setError(null);
    setManualDownload(null);
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

        {!activeManifest ? (
          <>
            <div role="toolbar" aria-label="Filter libraries by output type" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                autoFocus
                aria-pressed={outputFilter === "all"}
                onClick={() => setOutputFilter("all")}
                style={{ ...control, minHeight: 36, padding: "7px 12px", background: outputFilter === "all" ? t.highlight : t.bg, color: outputFilter === "all" ? t.highlightFg : t.fg }}
              >
                All
              </button>
              {outputFilters.map(({ type, label }) => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={outputFilter === type}
                  onClick={() => setOutputFilter(type)}
                  style={{ ...control, minHeight: 36, padding: "7px 12px", background: outputFilter === type ? t.highlight : t.bg, color: outputFilter === type ? t.highlightFg : t.fg }}
                >
                  {label}
                </button>
              ))}
            </div>

            <p aria-live="polite" style={{ margin: "16px 0 9px", color: t.muted, fontSize: 13 }}>
              {filteredManifests.length} {filteredManifests.length === 1 ? "library" : "libraries"}
            </p>
            {filteredManifests.length > 0 ? (
              <div role="list" aria-label="Foreign libraries" style={{ display: "grid", gap: 10 }}>
                {filteredManifests.map((manifest) => (
                  <div key={manifest.id} role="listitem">
                    <button
                      type="button"
                      onClick={() => chooseLibrary(manifest)}
                      style={{ ...control, width: "100%", height: "auto", display: "grid", gap: 8, padding: 14, textAlign: "left", cursor: "pointer" }}
                    >
                      <span style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                        <strong style={{ fontSize: 16 }}>{manifest.name}</strong>
                        <span style={{ color: t.muted, fontSize: 12 }}>Open →</span>
                      </span>
                      <span style={{ color: t.muted, fontSize: 13, lineHeight: 1.45 }}>{manifest.description}</span>
                      <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {manifest.outputs.map((output) => (
                          <span key={output.type} style={{ padding: "3px 7px", border: `1px solid ${t.border}`, borderRadius: 999, color: t.muted, fontSize: 11, fontWeight: 650 }}>
                            {output.label}
                          </span>
                        ))}
                      </span>
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p role="status" style={{ padding: 16, border: `1px solid ${t.border}`, borderRadius: 8, color: t.muted }}>No libraries provide this output type.</p>
            )}
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={showLibraries} style={{ border: 0, margin: "0 0 12px", padding: 0, background: "transparent", color: t.highlight, font: "inherit", cursor: "pointer" }}>← All libraries</button>
            <div style={{ marginBottom: 14 }}>
              <h3 style={{ margin: "0 0 4px", fontSize: 17 }}>{activeManifest.name}</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {activeManifest.outputs.map((output) => (
                  <span key={output.type} style={{ color: t.muted, fontSize: 12 }}>{output.label}</span>
                ))}
              </div>
            </div>
            {activeManifest.capabilities.includes("catalog.search") ? (
              <form onSubmit={(event) => { event.preventDefault(); void search(); }} style={{ display: "flex", gap: 10, alignItems: "end" }}>
                <label style={{ display: "grid", gap: 6, flex: 1, fontSize: 13 }}>
                  Search {activeManifest.name}
                  <input autoFocus value={query} disabled={busy || !session} onChange={(event) => setQuery(event.target.value)} placeholder="Title or author" style={{ ...control, width: "100%" }} />
                </label>
                <button type="submit" disabled={busy || !session || !query.trim()} style={{ ...control, border: 0, minWidth: 96, background: t.highlight, color: t.highlightFg, fontWeight: 650 }}>{busy ? "Working…" : "Search"}</button>
              </form>
            ) : (
              <p style={{ color: t.muted }}>This library does not provide catalog search.</p>
            )}
          </>
        )}

        {error && <p role="alert" style={{ margin: "14px 0 0", padding: "10px 12px", borderRadius: 8, color: t.danger, background: t.dangerBg, fontSize: 14 }}>{error}</p>}

        {activeManifest && manualDownload && (
          <div role="note" style={{ marginTop: 12, padding: 12, border: `1px solid ${t.border}`, borderRadius: 8, background: t.bg }}>
            <strong style={{ display: "block", marginBottom: 5 }}>{manualDownload.plan.acquisition === "manual" ? "Download from the source." : "Direct import is unavailable in this browser."}</strong>
            <span style={{ display: "block", color: t.muted, fontSize: 13, lineHeight: 1.45 }}>Download the {manualDownload.plan.file.extension.toUpperCase()} in your browser, then choose that file here. Speedreader will retain the catalog provenance.</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
              <a href={manualDownload.url} target="_blank" rel="external noopener noreferrer" download={manualDownload.fileName} style={{ ...control, display: "inline-flex", alignItems: "center", textDecoration: "none" }}>Download {manualDownload.plan.file.extension.toUpperCase()}</a>
              {onImportManual && <button type="button" disabled={busy} onClick={() => { void importManualDownload(); }} style={{ ...control, border: 0, background: t.highlight, color: t.highlightFg, fontWeight: 650 }}>Choose downloaded {manualDownload.plan.file.extension.toUpperCase()}</button>}
            </div>
          </div>
        )}

        {activeManifest && selected ? (
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
                  <span style={{ color: t.muted }}>
                    {libraryOutputLabel(activeManifest, offer.outputType)}
                    {offer.byteLength ? ` · ${(offer.byteLength / 1024 / 1024).toFixed(1)} MB` : ""}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : activeManifest && items.length > 0 ? (
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
