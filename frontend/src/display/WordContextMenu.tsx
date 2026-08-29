// src/display/WordContextMenu.tsx
// Context menu shown on long-press (or right-click) on a word in read-along view.
// Offers actions such as setting playback position, resuming from the word,
// or extensible actions (e.g., highlighting / selection / copying).

import { useEffect, useRef } from "react";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";

export interface WordContextMenuState {
  x: number;
  y: number;
  wordIndex: number;
  wordText: string;
}

export interface WordContextMenuProps {
  state: WordContextMenuState | null;
  onClose: () => void;
  onSetPosition: (index: number) => void;
  onResumeFromHere: (index: number) => void;
  theme: Theme;
}

export function WordContextMenu({
  state,
  onClose,
  onSetPosition,
  onResumeFromHere,
  theme,
}: WordContextMenuProps) {
  const t = themeTokens(theme);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on Escape, outside pointer down, or container scroll.
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [state, onClose]);

  if (!state) return null;

  const menuWidth = 220;
  const menuHeight = 130;
  const x = Math.max(10, Math.min(state.x, window.innerWidth - menuWidth - 10));
  const y = Math.max(10, Math.min(state.y, window.innerHeight - menuHeight - 10));

  return (
    <div
      ref={ref}
      role="menu"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 2500,
        minWidth: menuWidth,
        borderRadius: 12,
        border: `1px solid ${t.border}`,
        background: `${t.panel}f4`,
        backdropFilter: "blur(20px) saturate(1.4)",
        WebkitBackdropFilter: "blur(20px) saturate(1.4)",
        boxShadow: "0 10px 32px rgba(0,0,0,0.28)",
        padding: 6,
        fontFamily: "system-ui",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div
        style={{
          padding: "6px 10px 4px",
          fontSize: 11,
          color: t.muted,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          borderBottom: `1px solid ${t.border}66`,
          marginBottom: 4,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        Word: &ldquo;{state.wordText}&rdquo; (#{state.wordIndex + 1})
      </div>

      <button
        role="menuitem"
        onClick={() => {
          onSetPosition(state.wordIndex);
          onClose();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          textAlign: "left",
          padding: "8px 10px",
          borderRadius: 6,
          border: "none",
          background: "transparent",
          color: t.fg,
          fontSize: 13,
          fontWeight: 500,
          cursor: "pointer",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = t.hover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <span>📍</span>
        <span>Set Position Here</span>
      </button>

      <button
        role="menuitem"
        onClick={() => {
          onResumeFromHere(state.wordIndex);
          onClose();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          textAlign: "left",
          padding: "8px 10px",
          borderRadius: 6,
          border: "none",
          background: "transparent",
          color: t.highlight,
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = t.hover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <span>⚡</span>
        <span>Jump & Resume</span>
      </button>
    </div>
  );
}
