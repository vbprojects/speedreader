import { useEffect, useRef } from "react";
import type { Theme } from "../settings/types";
import type { InteractionResponse, ReaderInteraction } from "./types";
import { ChoiceInteraction } from "./ChoiceInteraction";
import { ContinueInteraction } from "./ContinueInteraction";
import { TextInputInteraction } from "./TextInputInteraction";

export function InteractionOverlay({
  interaction,
  theme = "light",
  busy = false,
  error,
  onSubmit,
}: {
  interaction: ReaderInteraction | null;
  theme?: Theme;
  busy?: boolean;
  error?: string | null;
  onSubmit: (response: InteractionResponse) => Promise<void> | void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!interaction) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const focusableElements = () => Array.from(overlay.querySelectorAll<HTMLElement>(focusableSelector));
    const initialFocus = focusableElements()[0];
    if (initialFocus && !overlay.contains(document.activeElement)) initialFocus.focus();

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusableElements();
      if (elements.length === 0) {
        event.preventDefault();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      previouslyFocused?.focus();
    };
  }, [interaction?.id]);

  if (!interaction) return null;
  return (
    <div
      ref={overlayRef}
      role="presentation"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        boxSizing: "border-box",
        background: "rgba(0, 0, 0, 0.48)",
      }}
    >
      {interaction.kind === "text-input" && (
        <TextInputInteraction interaction={interaction} theme={theme} busy={busy} error={error} onSubmit={onSubmit} />
      )}
      {interaction.kind === "single-choice" && (
        <ChoiceInteraction interaction={interaction} theme={theme} busy={busy} error={error} onSubmit={onSubmit} />
      )}
      {interaction.kind === "continue" && (
        <ContinueInteraction interaction={interaction} theme={theme} busy={busy} error={error} onSubmit={onSubmit} />
      )}
    </div>
  );
}
