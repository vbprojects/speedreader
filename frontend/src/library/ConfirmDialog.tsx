// src/library/ConfirmDialog.tsx
// A small themed confirmation dialog for destructive actions (remove book).

import { useEffect, useId, useRef } from "react";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  theme: Theme;
}

export function ConfirmDialog({ open, title, message, confirmLabel = "Remove", onConfirm, onCancel, theme }: ConfirmDialogProps) {
  const t = themeTokens(theme);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);

  if (!open) return null;

  return (
    <dialog ref={dialog} aria-labelledby={titleId} className="confirm-dialog"
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}
      style={{ padding: 0, border: 0, borderRadius: 16, background: "transparent", maxWidth: "min(92vw, 440px)", color: t.fg }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "min(92vw, 380px)",
          borderRadius: 16,
          border: `1px solid ${t.border}`,
          background: `${t.panel}e6`,
          backdropFilter: "blur(24px) saturate(1.4)",
          WebkitBackdropFilter: "blur(24px) saturate(1.4)",
          boxShadow: "0 8px 40px rgba(0,0,0,0.25)",
          padding: 20,
          color: t.fg,
          fontFamily: "system-ui",
        }}
      >
        <h3 id={titleId} style={{ marginTop: 0, marginBottom: 8 }}>{title}</h3>
        <p style={{ margin: "0 0 20px", color: t.muted, fontSize: 14, lineHeight: 1.5 }}>{message}</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            autoFocus
            onClick={onCancel}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: `1px solid ${t.border}`,
              background: t.panel,
              color: t.fg,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: "none",
              background: "#e5484d",
              color: "#fff",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}