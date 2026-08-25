import { useState } from "react";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";
import type { ChoiceInteraction as ChoiceDescriptor, ChoiceResponse } from "./types";
import { InteractionCard } from "./InteractionCard";

export function ChoiceInteraction({
  interaction,
  theme = "light",
  busy = false,
  error,
  onSubmit,
}: {
  interaction: ChoiceDescriptor;
  theme?: Theme;
  busy?: boolean;
  error?: string | null;
  onSubmit: (response: ChoiceResponse) => Promise<void> | void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const t = themeTokens(theme);

  const choose = async (optionId: string) => {
    setSelected(optionId);
    setLocalError(null);
    try {
      await onSubmit({ schemaVersion: 1, interactionId: interaction.id, kind: "single-choice", optionId });
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
      setSelected(null);
    }
  };

  return (
    <InteractionCard interaction={interaction} theme={theme} busy={busy} error={error ?? localError}>
      <div role="group" aria-label={interaction.prompt ?? "Choices"} style={{ display: "grid", gap: 10 }}>
        {interaction.options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={busy || option.disabled}
            aria-pressed={selected === option.id}
            onClick={() => void choose(option.id)}
            style={{
              textAlign: "left",
              padding: "12px 14px",
              borderRadius: 12,
              border: "1px solid " + (selected === option.id ? t.highlight : t.border),
              background: selected === option.id ? t.highlight + "22" : t.bg + "aa",
              color: t.fg,
              font: "inherit",
              cursor: busy || option.disabled ? "not-allowed" : "pointer",
              opacity: option.disabled ? 0.5 : 1,
            }}
          >
            <span style={{ display: "block", fontWeight: 650 }}>{option.label}</span>
            {option.description && (
              <span style={{ display: "block", marginTop: 4, color: t.muted, fontSize: 13 }}>
                {option.description}
              </span>
            )}
          </button>
        ))}
      </div>
    </InteractionCard>
  );
}
