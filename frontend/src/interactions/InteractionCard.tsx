import { useId, type ReactNode } from "react";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";
import type { ReaderInteraction } from "./types";

export interface InteractionCardProps {
  interaction: ReaderInteraction;
  theme?: Theme;
  children: ReactNode;
  busy?: boolean;
  error?: string | null;
  inline?: boolean;
}

export function InteractionCard({
  interaction,
  theme = "light",
  children,
  busy = false,
  error,
  inline = false,
}: InteractionCardProps) {
  const t = themeTokens(theme);
  const generatedId = useId();
  const titleId = generatedId + "-title";
  const descriptionId = generatedId + "-description";
  const title =
    interaction.kind === "text-input"
      ? interaction.label
      : interaction.kind === "single-choice"
        ? interaction.prompt ?? "Choose an option"
        : interaction.label ?? "Continue";

  return (
    <section
      role={inline ? "group" : "dialog"}
      aria-modal={inline ? undefined : "true"}
      aria-labelledby={titleId}
      aria-describedby={interaction.prompt && interaction.kind !== "single-choice" ? descriptionId : undefined}
      aria-busy={busy || undefined}
      style={{
        width: inline ? "min(100%, 480px)" : "min(calc(100vw - 32px), 520px)",
        maxWidth: "100%",
        boxSizing: "border-box",
        padding: "clamp(16px, 4vw, 24px)",
        borderRadius: 12,
        border: "1px solid " + t.border,
        background: t.panel,
        color: t.fg,
        boxShadow: inline ? "0 2px 8px rgba(0, 0, 0, 0.1)" : "0 16px 48px rgba(0, 0, 0, 0.24)",
        // Reader text size is intentionally large in RSVP mode. Controls need
        // their own stable scale so they remain usable on narrow screens.
        fontSize: 16,
        lineHeight: 1.4,
        textAlign: "left",
      }}
        data-interaction-id={interaction.id}
        data-interaction-inline={inline ? "true" : undefined}
    >
      <h2 id={titleId} style={{ margin: 0, fontSize: 20, lineHeight: 1.3, overflowWrap: "anywhere" }}>
        {title}
      </h2>
      {interaction.prompt && interaction.kind !== "single-choice" && (
        <p id={descriptionId} style={{ margin: "10px 0 18px", color: t.muted, lineHeight: 1.5 }}>
          {interaction.prompt}
        </p>
      )}
      {error && (
        <p role="alert" style={{ margin: "0 0 16px", padding: "10px 12px", borderRadius: 8, color: t.danger, background: t.dangerBg, fontSize: 14 }}>
          {error}
        </p>
      )}
      {children}
    </section>
  );
}
