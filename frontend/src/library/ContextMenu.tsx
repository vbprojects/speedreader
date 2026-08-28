// src/library/ContextMenu.tsx
// A themed context menu anchored to the pointer. Used for library tiles:
// right-click (desktop) or long-press (touch). Built-in books expose a
// restart action instead of removal.

import { useEffect, useRef } from "react";
import type { Book } from "../db/types";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";

export interface ContextMenuState {
  x: number;
  y: number;
  bookId: string;
}

export interface ContextMenuProps {
  state: ContextMenuState | null;
  book?: Book;
  onClose: () => void;
  onRemove: (bookId: string) => void;
  onRestart?: (bookId: string) => void;
  theme: Theme;
}

export function ContextMenu({ state, book, onClose, onRemove, onRestart, theme }: ContextMenuProps) {
  const t = themeTokens(theme);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on Escape, click-outside, or scroll.
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [state, onClose]);

  if (!state) return null;

  // Keep the menu inside the viewport.
  const menuWidth = 200;
  const menuHeight = 48;
  const x = Math.min(state.x, window.innerWidth - menuWidth - 8);
  const y = Math.min(state.y, window.innerHeight - menuHeight - 8);

  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 2000,
        minWidth: menuWidth,
        borderRadius: 10,
        border: `1px solid ${t.border}`,
        background: `${t.panel}f2`,
        backdropFilter: "blur(16px) saturate(1.3)",
        WebkitBackdropFilter: "blur(16px) saturate(1.3)",
        boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
        padding: 4,
        fontFamily: "system-ui",
      }}
    >
      <button
        role="menuitem"
        onClick={() => {
          if (book?.builtIn && onRestart) onRestart(state.bookId);
          else onRemove(state.bookId);
        }}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          padding: "8px 12px",
          borderRadius: 6,
          border: "none",
          background: "transparent",
          color: "#e5484d",
          fontSize: 14,
          cursor: "pointer",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = t.hover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        {book?.builtIn
          ? book.format === "bluesky-jetstream"
            ? "Clear live history"
            : book.format === "openai-compatible-llm"
              ? "Clear conversation"
              : "Restart demo"
          : "Remove from library"}
      </button>
    </div>
  );
}
