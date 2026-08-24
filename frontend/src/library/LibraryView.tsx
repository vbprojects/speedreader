// src/library/LibraryView.tsx
// The root library screen: grid of book tiles (cover + title footer),
// import action, empty state, and a remove-only context menu (right-click /
// long-press). Opening a book calls onOpen(bookId).

import { useEffect, useRef, useState } from "react";
import type { Book } from "../db/types";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";

export interface LibraryViewProps {
  books: Book[];
  /** True while the library is loading from the db. */
  loading: boolean;
  /** True while an import is in progress. */
  importing: boolean;
  error: string | null;
  theme: Theme;
  onImport: () => void;
  onOpen: (bookId: string) => void;
  onRemove: (bookId: string) => void;
  /** Saved position per book id (for progress display). */
  positions?: Record<string, number>;
}

/** Long-press threshold (ms) before a touch opens the context menu. */
const LONG_PRESS_MS = 500;

export function LibraryView({ books, loading, importing, error, theme, onImport, onOpen, onRemove, positions }: LibraryViewProps) {
  const t = themeTokens(theme);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [confirmBook, setConfirmBook] = useState<Book | null>(null);

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

  const confirmRemove = () => {
    if (confirmBook) onRemove(confirmBook.id);
    setConfirmBook(null);
  };

  return (
    <div style={{ minHeight: "100vh", background: t.bg, color: t.fg, fontFamily: "system-ui" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "16px 24px",
          borderBottom: `1px solid ${t.border}`,
          background: t.panel,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, flex: 1 }}>Library</h1>
        <button
          onClick={onImport}
          disabled={importing}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: "none",
            background: t.highlight,
            color: t.highlightFg,
            cursor: importing ? "default" : "pointer",
            fontSize: 14,
            fontWeight: 600,
            opacity: importing ? 0.7 : 1,
          }}
        >
          {importing ? "Importing…" : "Import EPUB"}
        </button>
      </div>

      {error && (
        <div style={{ padding: "12px 24px", color: "#e5484d", fontSize: 14 }}>{error}</div>
      )}

      {/* Body */}
      <div style={{ padding: 24 }}>
        {loading ? (
          <div style={{ color: t.muted, padding: 40, textAlign: "center" }}>Loading library…</div>
        ) : books.length === 0 ? (
          <div style={{ textAlign: "center", padding: 80, color: t.muted }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📚</div>
            <div style={{ fontSize: 18, marginBottom: 8 }}>Your library is empty</div>
            <div style={{ fontSize: 14, marginBottom: 24 }}>Import an EPUB to start speedreading.</div>
            <button
              onClick={onImport}
              disabled={importing}
              style={{
                padding: "10px 20px",
                borderRadius: 8,
                border: "none",
                background: t.highlight,
                color: t.highlightFg,
                cursor: "pointer",
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {importing ? "Importing…" : "Import your first EPUB"}
            </button>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
              gap: 20,
            }}
          >
            {books.map((book) => (
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
      </div>

      <ContextMenu state={menu} onClose={() => setMenu(null)} onRemove={handleRemove} theme={theme} />
      <ConfirmDialog
        open={!!confirmBook}
        title="Remove from library?"
        message={`"${confirmBook?.title ?? ""}" and its saved reading progress will be deleted. This can't be undone.`}
        onConfirm={confirmRemove}
        onCancel={() => setConfirmBook(null)}
        theme={theme}
      />
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
        borderRadius: 12,
        overflow: "hidden",
        border: `1px solid ${t.border}`,
        background: t.panel,
        boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
        transition: "transform 0.15s ease, box-shadow 0.15s ease",
        userSelect: "none",
        WebkitUserSelect: "none",
        touchAction: "pan-y",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = "0 6px 18px rgba(0,0,0,0.15)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.08)";
      }}
    >
      {/* Cover area */}
      <div
        style={{
          aspectRatio: "2 / 3",
          background: t.bg,
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
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
          <TitleCard title={book.title} theme={theme} />
        )}
        {pct > 0 && (
          <div
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              background: "rgba(0,0,0,0.6)",
              color: "#fff",
              borderRadius: 999,
              padding: "2px 8px",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {pct}%
          </div>
        )}
      </div>

      {/* Title footer */}
      <div style={{ padding: "10px 12px" }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            lineHeight: 1.3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={book.title}
        >
          {book.title}
        </div>
        <div style={{ fontSize: 12, color: t.muted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {book.author}
        </div>
      </div>
    </div>
  );
}

/** Deterministic styled title card used when a book has no embedded cover. */
function TitleCard({ title, theme }: { title: string; theme: Theme }) {
  void theme;
  // Deterministic hue from the title so the same book always gets the same card.
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const bg = `linear-gradient(135deg, hsl(${hue}, 55%, 42%), hsl(${(hue + 40) % 360}, 55%, 28%))`;

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
      }}
    >
      <div style={{ color: "#fff", textAlign: "center" }}>
        <div style={{ fontSize: 34, fontWeight: 700, lineHeight: 1.1, wordBreak: "break-word" }}>
          {title.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?"}
        </div>
      </div>
    </div>
  );
}