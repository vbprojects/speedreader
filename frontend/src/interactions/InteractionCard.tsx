import type { ReactNode } from "react";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";
import type { ReaderInteraction } from "./types";

export interface InteractionCardProps {
  interaction: ReaderInteraction;
  theme?: Theme;
  children: ReactNode;
  busy?: boolean;
  error?: string | null;
}

export function InteractionCard({
  interaction,
  theme = "light",
  children,
  busy = false,
  error,
}: InteractionCardProps) {
  const t = themeTokens(theme);
  const titleId = "interaction-title-" + interaction.id;
  const descriptionId = "interaction-description-" + interaction.id;
  const title =
    interaction.kind === "text-input"
      ? interaction.label
      : interaction.kind === "single-choice"
        ? interaction.prompt ?? "Choose an option"
        : interaction.label ?? "Continue";

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={interaction.prompt && interaction.kind !== "single-choice" ? descriptionId : undefined}
      style={{
        width: "min(92vw, 520px)",
        boxSizing: "border-box",
        padding: 24,
        borderRadius: 20,
        border: "1px solid " + t.border + "99",
        background: t.panel + "ef",
        color: t.fg,
        boxShadow: "0 24px 80px rgba(0, 0, 0, 0.28)",
        backdropFilter: "blur(22px) saturate(130%)",
        WebkitBackdropFilter: "blur(22px) saturate(130%)",
        opacity: busy ? 0.75 : 1,
      }}
      data-interaction-id={interaction.id}
    >
      <h2 id={titleId} style={{ margin: 0, fontSize: 20, lineHeight: 1.3 }}>
        {title}
      </h2>
      {interaction.prompt && interaction.kind !== "single-choice" && (
        <p id={descriptionId} style={{ margin: "10px 0 18px", color: t.muted, lineHeight: 1.5 }}>
          {interaction.prompt}
        </p>
      )}
      {error && (
        <p role="alert" style={{ margin: "0 0 12px", color: t.highlight, fontSize: 14 }}>
          {error}
        </p>
      )}
      {children}
    </section>
  );
}
