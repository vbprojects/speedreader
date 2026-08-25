import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";
import type { ContinueInteraction as ContinueDescriptor, ContinueResponse } from "./types";
import { InteractionCard } from "./InteractionCard";

export function ContinueInteraction({
  interaction,
  theme = "light",
  busy = false,
  error,
  onSubmit,
  inline = false,
}: {
  interaction: ContinueDescriptor;
  theme?: Theme;
  busy?: boolean;
  error?: string | null;
  onSubmit: (response: ContinueResponse) => Promise<void> | void;
  inline?: boolean;
}) {
  const t = themeTokens(theme);
  return (
    <InteractionCard interaction={interaction} theme={theme} busy={busy} error={error} inline={inline}>
      {interaction.description && <p style={{ margin: "0 0 18px", color: t.muted }}>{interaction.description}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => void onSubmit({ schemaVersion: 1, interactionId: interaction.id, kind: "continue" })}
        style={{
          width: "100%",
          padding: "11px 14px",
          border: 0,
          borderRadius: 12,
          background: t.highlight,
          color: t.highlightFg,
          font: "inherit",
          fontWeight: 650,
          cursor: busy ? "wait" : "pointer",
        }}
      >
        {busy ? "Saving…" : interaction.label ?? "Continue"}
      </button>
    </InteractionCard>
  );
}
