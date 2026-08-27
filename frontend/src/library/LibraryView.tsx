// src/library/LibraryView.tsx
// The root library screen: grid of glassmorphic book tiles (cover + title footer),
// search bar, import action, settings modal, and a context menu (right-click /
// long-press). Built-in demo books can be restarted; imported books can be removed.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Book } from "../db/types";
import { JETSTREAM_FORMAT } from "../ingestion/jetstream";
import type { GlobalSettings, ReaderSettings, Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";
import { SettingsModal } from "../settings/SettingsModal";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";

export interface LibraryViewProps {
  books: Book[];
  /** True while the library is loading from the db. */
  loading: boolean;
  /** True while an import is in progress. */
  importing: boolean;
  error: string | null;
  /** Non-fatal import caveat that the reader should review. */
  notice?: string | null;
  theme: Theme;
  settings?: GlobalSettings;
  onUpdateSettings?: (patch: ReaderSettings) => void;
  onImport: () => void;
  onOpen: (bookId: string) => void;
  onRemove: (bookId: string) => void;
  onRestart?: (bookId: string) => void;
  /** Saved position per book id (for progress display). */
  positions?: Record<string, number>;
}

/** Long-press threshold (ms) before a touch opens the context menu. */
const LONG_PRESS_MS = 500;

export function LibraryView({
  books,
  loading,
  importing,
  error,
  notice,
  theme,
  settings,
  onUpdateSettings,
  onImport,
  onOpen,
  onRemove,
  onRestart,
  positions,
}: LibraryViewProps) {
  const t = themeTokens(theme);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [confirmBook, setConfirmBook] = useState<Book | null>(null);

  // Filter books by title or author
  const filteredBooks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return books;
    return books.filter(
      (b) =>
        b.title.toLowerCase().includes(q) ||
        b.author.toLowerCase().includes(q)
    );
  }, [books, searchQuery]);

  // Long-press tracking per tile.
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; bookId: string | null; moved: boolean }>({
    timer: null,
    bookId: null,
    moved: false,
  });

  const clearLongPress = () => {
    const lp = longPressRef.current;
    if (lp.timer) clearTimeout(lp.timer);
    lp.timer = null;
    lp.bookId = null;
    lp.moved = false;
  };

  const startLongPress = (e: React.PointerEvent, book: Book) => {
    // Only for touch pointers.
    if (e.pointerType !== "touch") return;
    clearLongPress();
    const lp = longPressRef.current;
    lp.bookId = book.id;
    lp.moved = false;
    lp.timer = setTimeout(() => {
      if (!lp.moved) {
        setMenu({ x: e.clientX, y: e.clientY, bookId: book.id });
      }
      clearLongPress();
    }, LONG_PRESS_MS);
  };

  const onTilePointerMove = (e: React.PointerEvent) => {
    const lp = longPressRef.current;
    if (lp.timer && lp.bookId) {
      // Cancel if the finger moves too far (a scroll, not a long press).
      if (Math.abs(e.movementX) > 10 || Math.abs(e.movementY) > 10) {
        lp.moved = true;
        clearLongPress();
      }
    }
  };

  const onTilePointerUp = () => clearLongPress();
  const onTilePointerCancel = () => clearLongPress();

  const handleContextMenu = (e: React.MouseEvent, book: Book) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, bookId: book.id });
  };

  const handleTileClick = (book: Book) => {
    // A long press that opened the menu shouldn't also open the book.
    if (menu?.bookId === book.id) return;
    onOpen(book.id);
  };

  const handleRemove = (bookId: string) => {
    setMenu(null);
    const book = books.find((b) => b.id === bookId);
    if (book) setConfirmBook(book);
  };

  const handleRestart = (bookId: string) => {
    setMenu(null);
    onRestart?.(bookId);
  };

  const confirmRemove = () => {
    if (confirmBook) onRemove(confirmBook.id);
    setConfirmBook(null);
  };

  // Glassmorphic surface styles
  const glassHeaderStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
    padding: "16px 24px",
    borderBottom: `1px solid ${t.border}`,
    background: `${t.panel}bb`,
    backdropFilter: "blur(20px) saturate(1.3)",
    WebkitBackdropFilter: "blur(20px) saturate(1.3)",
    position: "sticky",
    top: 0,
    zIndex: 100,
    boxShadow: "0 4px 20px rgba(0,0,0,0.05)",
  };

  const searchInputStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 180,
    maxWidth: 400,
    padding: "8px 14px 8px 34px",
    borderRadius: 12,
    border: `1px solid ${t.border}`,
    background: `${t.bg}88`,
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    color: t.fg,
    fontSize: 14,
    fontFamily: "inherit",
    outline: "none",
    boxShadow: "inset 0 1px 3px rgba(0,0,0,0.06)",
    transition: "border-color 0.2s ease, box-shadow 0.2s ease",
  };

  const glassButtonStyle: React.CSSProperties = {
    padding: "8px 16px",
    borderRadius: 10,
    border: `1px solid ${t.border}`,
    background: `${t.panel}cc`,
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    color: t.fg,
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 500,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    transition: "all 0.15s ease",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  };

  const primaryButtonStyle: React.CSSProperties = {
    ...glassButtonStyle,
    border: "none",
    background: t.highlight,
    color: t.highlightFg,
    fontWeight: 600,
    opacity: importing ? 0.7 : 1,
    cursor: importing ? "default" : "pointer",
    boxShadow: "0 4px 14px rgba(0,0,0,0.15)",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: `radial-gradient(circle at 10% 10%, ${t.panel}44 0%, transparent 40%), radial-gradient(circle at 90% 90%, ${t.highlight}15 0%, transparent 45%), ${t.bg}`,
        color: t.fg,
        fontFamily: settings?.fontFamily ?? "system-ui",
      }}
    >
      {/* Glassmorphic Header */}
      <header style={glassHeaderStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: `linear-gradient(135deg, ${t.highlight}, ${t.highlight}bb)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: t.highlightFg,
              fontSize: 18,
              fontWeight: 800,
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          >
            ⚡
          </div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em" }}>Library</h1>
        </div>

        {/* Search Bar with Glassmorphic styling */}
        <div style={{ position: "relative", display: "flex", alignItems: "center", flex: 1, justifyContent: "center", maxWidth: 440 }}>
          <span
            style={{
              position: "absolute",
              left: 12,
              color: t.muted,
              fontSize: 14,
              pointerEvents: "none",
            }}
          >
            🔍
          </span>
          <input
            type="text"
            placeholder="Search titles or authors…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={searchInputStyle}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              title="Clear search"
              style={{
                position: "absolute",
                right: 10,
                background: "transparent",
                border: "none",
                color: t.muted,
                cursor: "pointer",
                fontSize: 14,
                padding: 4,
              }}
            >
              ✕
            </button>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {settings && onUpdateSettings && (
            <button
              onClick={() => setShowSettings(true)}
              style={glassButtonStyle}
              title="Global Settings"
            >
              <span>⚙️</span>
              <span className="hide-on-mobile">Settings</span>
            </button>
          )}

          <button
            onClick={onImport}
            disabled={importing}
            style={primaryButtonStyle}
          >
            <span>➕</span>
            <span>{importing ? "Importing…" : "Import book"}</span>
          </button>
        </div>
      </header>

      {notice && (
        <div
          role="status"
          style={{
            margin: "16px 24px 0",
            padding: "12px 18px",
            borderRadius: 12,
            border: "1px solid #d9890044",
            background: "#d9890018",
            backdropFilter: "blur(12px)",
            color: "#8a5600",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          ⚠️ {notice}
        </div>
      )}

      {error && (
        <div
          style={{
            margin: "16px 24px 0",
            padding: "12px 18px",
            borderRadius: 12,
            border: "1px solid #e5484d44",
            background: "#e5484d18",
            backdropFilter: "blur(12px)",
            color: "#e5484d",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          {error}
        </div>
      )}

      {/* Main Content Body */}
      <main style={{ padding: "28px 24px" }}>
        {loading ? (
          <div style={{ color: t.muted, padding: 60, textAlign: "center", fontSize: 15 }}>
            <div style={{ fontSize: 28, marginBottom: 12 }}>⏳</div>
            Loading library…
          </div>
        ) : books.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "80px 24px",
              borderRadius: 24,
              border: `1px solid ${t.border}`,
              background: `${t.panel}66`,
              backdropFilter: "blur(16px)",
              WebkitBackdropFilter: "blur(16px)",
              maxWidth: 480,
              margin: "40px auto",
              boxShadow: "0 8px 32px rgba(0,0,0,0.06)",
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 16 }}>📚</div>
            <h2 style={{ fontSize: 20, margin: "0 0 8px", fontWeight: 700 }}>Your library is empty</h2>
            <p style={{ fontSize: 14, margin: "0 0 24px", color: t.muted, lineHeight: 1.5 }}>
              Import an EPUB or PDF to start your speedreading journey with centered focal alignment.
            </p>
            <button
              onClick={onImport}
              disabled={importing}
              style={primaryButtonStyle}
            >
              {importing ? "Importing…" : "Import your first book"}
            </button>
          </div>
        ) : filteredBooks.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "60px 24px",
              borderRadius: 20,
              border: `1px solid ${t.border}`,
              background: `${t.panel}55`,
              backdropFilter: "blur(12px)",
              color: t.muted,
              maxWidth: 400,
              margin: "30px auto",
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: t.fg, marginBottom: 4 }}>No matching books</div>
            <div style={{ fontSize: 13 }}>No books found matching &ldquo;{searchQuery}&rdquo;</div>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
              gap: 22,
            }}
          >
            {filteredBooks.map((book) => (
              <BookTile
                key={book.id}
                book={book}
                theme={theme}
                progress={positions?.[book.id]}
                onContextMenu={(e) => handleContextMenu(e, book)}
                onPointerDown={(e) => startLongPress(e, book)}
                onPointerMove={onTilePointerMove}
                onPointerUp={onTilePointerUp}
                onPointerCancel={onTilePointerCancel}
                onClick={() => handleTileClick(book)}
              />
            ))}
          </div>
        )}
      </main>

      {/* Global Settings Modal */}
      {settings && onUpdateSettings && (
        <SettingsModal
          open={showSettings}
          onClose={() => setShowSettings(false)}
          settings={settings}
          onChange={onUpdateSettings}
          theme={theme}
        />
      )}

      {/* Context Menu & Confirmation Dialog */}
      <ContextMenu
        state={menu}
        book={menu ? books.find((book) => book.id === menu.bookId) : undefined}
        onClose={() => setMenu(null)}
        onRemove={handleRemove}
        onRestart={handleRestart}
        theme={theme}
      />
      <ConfirmDialog
        open={!!confirmBook}
        title="Remove from library?"
        message={`"${confirmBook?.title ?? ""}" and its saved reading progress will be deleted. This can't be undone.`}
        onConfirm={confirmRemove}
        onCancel={() => setConfirmBook(null)}
        theme={theme}
      />

      <style>{`
        @media (max-width: 600px) {
          .hide-on-mobile { display: none !important; }
        }
      `}</style>
    </div>
  );
}

interface BookTileProps {
  book: Book;
  theme: Theme;
  progress?: number;
  onContextMenu: (e: React.MouseEvent) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  onClick: () => void;
}

function BookTile({ book, theme, progress, onContextMenu, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick }: BookTileProps) {
  const t = themeTokens(theme);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  // Convert the stored cover Blob to an object URL at render time; revoke on
  // change/unmount to avoid leaking memory across many tiles.
  useEffect(() => {
    if (!book.cover) {
      setCoverUrl(null);
      return;
    }
    const url = URL.createObjectURL(book.cover.blob);
    setCoverUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [book.cover]);

  const pct = progress !== undefined && book.wordCount > 0 ? Math.min(100, Math.round((progress / book.wordCount) * 100)) : 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
      style={{
        cursor: "pointer",
        borderRadius: 16,
        overflow: "hidden",
        border: `1px solid ${t.border}`,
        background: `${t.panel}99`,
        backdropFilter: "blur(16px) saturate(1.2)",
        WebkitBackdropFilter: "blur(16px) saturate(1.2)",
        boxShadow: "0 6px 20px rgba(0,0,0,0.06), inset 0 1px 1px rgba(255,255,255,0.15)",
        transition: "all 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
        userSelect: "none",
        WebkitUserSelect: "none",
        touchAction: "pan-y",
        display: "flex",
        flexDirection: "column",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-4px)";
        e.currentTarget.style.boxShadow = "0 12px 28px rgba(0,0,0,0.14), inset 0 1px 1px rgba(255,255,255,0.25)";
        e.currentTarget.style.borderColor = t.highlight;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = "0 6px 20px rgba(0,0,0,0.06), inset 0 1px 1px rgba(255,255,255,0.15)";
        e.currentTarget.style.borderColor = t.border;
      }}
    >
      {/* Cover area */}
      <div
        style={{
          aspectRatio: "2 / 3",
          background: `${t.bg}99`,
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          borderBottom: `1px solid ${t.border}88`,
        }}
      >
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={book.title}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            draggable={false}
          />
        ) : (
          <TitleCard book={book} theme={theme} />
        )}
        {book.ingestionWarnings?.length ? (
          <div
            title={book.ingestionWarnings.join(" ")}
            style={{
              position: "absolute",
              top: 8,
              left: 8,
              background: "rgba(138,86,0,0.88)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              border: "1px solid rgba(255,255,255,0.2)",
              color: "#fff",
              borderRadius: 999,
              padding: "2px 8px",
              fontSize: 11,
              fontWeight: 600,
              boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
            }}
          >
            ⚠️ Check layout
          </div>
        ) : null}
        {book.builtIn && (
          <div
            title="Bundled offline demonstration"
            style={{
              position: "absolute",
              bottom: 8,
              left: 8,
              background: "rgba(0,0,0,0.55)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              border: "1px solid rgba(255,255,255,0.2)",
              color: "#fff",
              borderRadius: 999,
              padding: "2px 8px",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            Built-in
          </div>
        )}
        {pct > 0 && (
          <div
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              background: "rgba(0,0,0,0.55)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              border: "1px solid rgba(255,255,255,0.2)",
              color: "#fff",
              borderRadius: 999,
              padding: "2px 8px",
              fontSize: 11,
              fontWeight: 600,
              boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
            }}
          >
            {pct}%
          </div>
        )}
      </div>

      {/* Title footer (Glassmorphic panel) */}
      <div style={{ padding: "12px 14px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            lineHeight: 1.35,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={book.title}
        >
          {book.title}
        </div>
        <div
          style={{
            fontSize: 12,
            color: t.muted,
            marginTop: 4,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={book.author}
        >
          {book.author}
        </div>
      </div>
    </div>
  );
}

/** Offline Bluesky butterfly mark for the live-stream title card. */
function BlueskyLogo() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="58"
      height="58"
      role="img"
      aria-label="Bluesky"
      fill="#fff"
      style={{ filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.25))" }}
    >
      <path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364-4.67.69-5.886 2.964-3.308 5.242 4.74 4.186 6.878-.896 7.435-2.04.557 1.144 2.695 6.226 7.435 2.04 2.578-2.278 1.362-4.552-3.308-5.242 2.67.296 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8Z" />
    </svg>
  );
}

/** Deterministic styled title card used when a book has no embedded cover. */
function TitleCard({ book, theme }: { book: Book; theme: Theme }) {
  void theme;
  const { title } = book;
  // Deterministic hue from the title so the same book always gets the same card.
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const bg = `linear-gradient(135deg, hsl(${hue}, 60%, 42%), hsl(${(hue + 45) % 360}, 65%, 26%))`;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        boxSizing: "border-box",
        position: "relative",
      }}
    >
      {/* Decorative ambient glass ring */}
      <div
        style={{
          position: "absolute",
          width: 80,
          height: 80,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.1)",
          backdropFilter: "blur(6px)",
          border: "1px solid rgba(255,255,255,0.2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {book.format === JETSTREAM_FORMAT ? (
          <BlueskyLogo />
        ) : (
          <span style={{ color: "#fff", fontSize: 28, fontWeight: 800, textShadow: "0 2px 8px rgba(0,0,0,0.3)" }}>
            {title.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?"}
          </span>
        )}
      </div>
    </div>
  );
}
