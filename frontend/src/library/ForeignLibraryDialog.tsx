import { useEffect, useMemo, useState } from "react";
import type {
  ForeignDownloadPlan,
  ForeignImportPlan,
  ForeignItem,
  ForeignLibraryManifest,
  ForeignPage,
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

type CatalogMode = "featured" | "search";

function itemIcon(item: ForeignItem): string {
  if (item.kind === "model") return "AI";
  if (item.kind === "paper") return "Σ";
  if (item.kind === "application") return "↗";
  if (item.kind === "feed") return "≋";
  return "Aa";
}

function itemDetails(item: ForeignItem): string {
  const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
    ? item.metadata as Record<string, unknown>
    : {};
  const contextLength = typeof metadata.contextLength === "number" ? metadata.contextLength : undefined;
  const context = contextLength
    ? `${contextLength >= 1_000_000 ? `${(contextLength / 1_000_000).toFixed(1)}M` : `${Math.round(contextLength / 1_000)}K`} context`
    : undefined;
  return [context, ...(item.subjects ?? []).slice(0, 2)].filter(Boolean).join(" · ");
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
  const [searchedQuery, setSearchedQuery] = useState("");
  const [items, setItems] = useState<ForeignItem[]>([]);
  const [catalogMode, setCatalogMode] = useState<CatalogMode>("featured");
  const [nextCursor, setNextCursor] = useState<string | undefined>();
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
    setSearchedQuery("");
    setCatalogMode("featured");
    setNextCursor(undefined);
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
    setSearchedQuery("");
    setCatalogMode("featured");
    setNextCursor(undefined);
    setSelected(null);
    setError(null);
    setManualDownload(null);
    setBusy(true);
    void registry.open(libraryId).then(async (value) => {
      opened = value;
      if (!active) {
        await value.dispose();
        return;
      }
      setSession(value);
      if (value.browse) {
        const page = await value.browse({ pageSize: 24 });
        if (active) {
          setItems(page.items);
          setNextCursor(page.nextCursor);
        }
      }
    }).catch((openError: unknown) => {
      if (active) setError(openError instanceof Error ? openError.message : String(openError));
    }).finally(() => {
      if (active) setBusy(false);
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
      const submittedQuery = query.trim();
      const page = await session.search({ query: submittedQuery, pageSize: 25 });
      setItems(page.items);
      setCatalogMode("search");
      setSearchedQuery(submittedQuery);
      setNextCursor(page.nextCursor);
      if (page.items.length === 0) setError("No matching items were found.");
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : String(searchError));
    } finally {
      setBusy(false);
    }
  };

  const showFeatured = async () => {
    if (!session?.browse || busy) return;
    setBusy(true);
    setError(null);
    setQuery("");
    setSearchedQuery("");
    setSelected(null);
    setManualDownload(null);
    try {
      const page = await session.browse({ pageSize: 24 });
      setItems(page.items);
      setCatalogMode("featured");
      setNextCursor(page.nextCursor);
    } catch (browseError) {
      setError(browseError instanceof Error ? browseError.message : String(browseError));
    } finally {
      setBusy(false);
    }
  };

  const loadMore = async () => {
    if (!session || !nextCursor || busy) return;
    setBusy(true);
    setError(null);
    try {
      let page: ForeignPage<ForeignItem>;
      if (catalogMode === "search") {
        if (!session.search) return;
        page = await session.search({ query: searchedQuery, cursor: nextCursor, pageSize: 24 });
      } else {
        if (!session.browse) return;
        page = await session.browse({ cursor: nextCursor, pageSize: 24 });
      }
      setItems((current) => {
        const seen = new Set(current.map((item) => `${item.ref.libraryId}:${item.ref.itemId}`));
        return [...current, ...page.items.filter((item) => !seen.has(`${item.ref.libraryId}:${item.ref.itemId}`))];
      });
      setNextCursor(page.nextCursor);
    } catch (pageError) {
      setError(pageError instanceof Error ? pageError.message : String(pageError));
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
    setSearchedQuery("");
    setCatalogMode("featured");
    setNextCursor(undefined);
    setSelected(null);
    setError(null);
    setManualDownload(null);
    setLibraryId(manifest.id);
  };

  const showLibraries = () => {
    setLibraryId("");
    setQuery("");
    setItems([]);
    setSearchedQuery("");
    setCatalogMode("featured");
    setNextCursor(undefined);
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
        style={{ width: "min(980px, 100%)", maxHeight: "calc(100vh - 32px)", overflow: "auto", boxSizing: "border-box", padding: 22, border: `1px solid ${t.border}`, borderRadius: 14, background: t.panel, color: t.fg, fontFamily: "system-ui", boxShadow: "0 18px 60px rgba(0,0,0,0.32)" }}
      >
        <div style={{ display: "flex", alignItems: "start", gap: 16, marginBottom: 18 }}>
          <div style={{ flex: 1 }}>
            <h2 id="foreign-library-title" style={{ margin: "0 0 6px", fontSize: 21 }}>Find external content</h2>
            <p style={{ margin: 0, color: t.muted, fontSize: 14, lineHeight: 1.45 }}>Browse external catalogs like a library, search their collections, then add content or services to Speedreader.</p>
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
            <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 16, marginBottom: 14 }}>
              <div>
              <h3 style={{ margin: "0 0 4px", fontSize: 19 }}>{activeManifest.name}</h3>
              <p style={{ margin: "0 0 7px", maxWidth: 680, color: t.muted, fontSize: 13, lineHeight: 1.45 }}>{activeManifest.description}</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {activeManifest.outputs.map((output) => (
                  <span key={output.type} style={{ padding: "3px 7px", border: `1px solid ${t.border}`, borderRadius: 999, color: t.muted, fontSize: 11 }}>{output.label}</span>
                ))}
              </div>
              </div>
            </div>
            {activeManifest.capabilities.includes("catalog.search") ? (
              <form aria-label={`Search ${activeManifest.name}`} onSubmit={(event) => { event.preventDefault(); void search(); }} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <label style={{ position: "relative", display: "flex", alignItems: "center", flex: 1 }}>
                  <span aria-hidden="true" style={{ position: "absolute", left: 13, color: t.muted }}>⌕</span>
                  <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>Search {activeManifest.name}</span>
                  <input autoFocus value={query} disabled={busy || !session} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, authors, models, or providers…" style={{ ...control, width: "100%", paddingLeft: 38 }} />
                </label>
                {catalogMode === "search" && session?.browse && (
                  <button type="button" disabled={busy} onClick={() => { void showFeatured(); }} style={control}>Featured</button>
                )}
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
            <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 14 }}>
              <span aria-hidden="true" style={{ width: 58, height: 70, display: "grid", placeItems: "center", flex: "0 0 auto", borderRadius: 10, background: `linear-gradient(145deg, ${t.highlight}33, ${t.bg})`, border: `1px solid ${t.border}`, color: t.highlight, fontWeight: 800 }}>{itemIcon(selected)}</span>
              <div>
                <h3 style={{ margin: "0 0 5px", fontSize: 19 }}>{selected.title}</h3>
                <p style={{ margin: 0, color: t.muted }}>{selected.authors?.join(", ") || "Unknown author"}</p>
                {itemDetails(selected) && <p style={{ margin: "5px 0 0", color: t.muted, fontSize: 12 }}>{itemDetails(selected)}</p>}
              </div>
            </div>
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
        ) : activeManifest ? (
          <div style={{ marginTop: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>{catalogMode === "featured" ? "Featured" : `Results for “${searchedQuery}”`}</h3>
              <span aria-live="polite" style={{ color: t.muted, fontSize: 12 }}>{items.length} {items.length === 1 ? "item" : "items"}</span>
            </div>
            {items.length > 0 ? (
              <div role="list" aria-label={`${activeManifest.name} catalog`} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 10 }}>
                {items.map((item) => (
                  <div key={`${item.ref.libraryId}:${item.ref.itemId}`} role="listitem">
                    <button type="button" disabled={busy} onClick={() => { void inspect(item); }} style={{ ...control, width: "100%", height: "100%", minHeight: 116, display: "flex", gap: 12, padding: 12, textAlign: "left", cursor: busy ? "wait" : "pointer" }}>
                      <span aria-hidden="true" style={{ width: 48, height: 64, display: "grid", placeItems: "center", flex: "0 0 auto", borderRadius: 9, background: `linear-gradient(145deg, ${t.highlight}2b, ${t.bg})`, border: `1px solid ${t.border}`, color: t.highlight, fontSize: 14, fontWeight: 800 }}>{itemIcon(item)}</span>
                      <span style={{ minWidth: 0, display: "grid", alignContent: "start", gap: 5 }}>
                        <strong style={{ overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", lineHeight: 1.3 }}>{item.title}</strong>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: t.muted, fontSize: 13 }}>{item.authors?.join(", ") || "Unknown author"}</span>
                        {itemDetails(item) && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: t.muted, fontSize: 11 }}>{itemDetails(item)}</span>}
                      </span>
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p role="status" style={{ padding: 18, border: `1px solid ${t.border}`, borderRadius: 9, color: t.muted }}>{busy ? "Loading catalog…" : "No catalog items are available."}</p>
            )}
            {nextCursor && (
              <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
                <button type="button" disabled={busy} onClick={() => { void loadMore(); }} style={control}>{busy ? "Loading…" : "Load more"}</button>
              </div>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
