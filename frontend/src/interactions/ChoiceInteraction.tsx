import { useEffect, useId, useState } from "react";
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
  inline = false,
}: {
  interaction: ChoiceDescriptor;
  theme?: Theme;
  busy?: boolean;
  error?: string | null;
  onSubmit: (response: ChoiceResponse) => Promise<void> | void;
  inline?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const groupId = useId();
  const t = themeTokens(theme);
  const firstEnabledIndex = interaction.options.findIndex((option) => !option.disabled);

  useEffect(() => {
    setSelected(null);
    setLocalError(null);
  }, [interaction.id]);

  const submit = async () => {
    if (!selected) {
      setLocalError("Choose an option.");
      return;
    }
    setLocalError(null);
    try {
      await onSubmit({ schemaVersion: 1, interactionId: interaction.id, kind: "single-choice", optionId: selected });
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <InteractionCard interaction={interaction} theme={theme} busy={busy} error={error ?? localError} inline={inline}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void submit();
        }}
      >
        <fieldset disabled={busy} style={{ display: "grid", gap: 10, margin: 0, padding: 0, border: 0 }}>
          <legend
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: "hidden",
              clip: "rect(0, 0, 0, 0)",
              whiteSpace: "nowrap",
              border: 0,
            }}
          >
            {interaction.prompt ?? "Choose an option"}
          </legend>
          {interaction.options.map((option, index) => {
            const optionInputId = groupId + "-option-" + index;
            return (
              <label
                key={option.id}
                htmlFor={optionInputId}
                style={{
                  display: "flex",
                  minHeight: 44,
                  alignItems: "flex-start",
                  gap: 10,
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid " + (selected === option.id ? t.highlight : t.border),
                  background: selected === option.id ? t.hover : t.bg,
                  color: t.fg,
                  cursor: busy || option.disabled ? "not-allowed" : "pointer",
                  opacity: option.disabled ? 0.5 : 1,
                }}
              >
                <input
                  id={optionInputId}
                  type="radio"
                  name={groupId}
                  value={option.id}
                  checked={selected === option.id}
                  disabled={option.disabled}
                  autoFocus={!inline && index === firstEnabledIndex}
                  onChange={() => {
                    setSelected(option.id);
                    setLocalError(null);
                  }}
                  style={{ margin: "3px 0 0", accentColor: t.highlight }}
                />
                <span>
                  <span style={{ display: "block", fontWeight: 650 }}>{option.label}</span>
                  {option.description && (
                    <span style={{ display: "block", marginTop: 4, color: t.muted, fontSize: 13 }}>
                      {option.description}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>
        <button
          type="submit"
          disabled={busy || selected === null}
          style={{
            width: "100%",
            minHeight: 44,
            marginTop: 14,
            padding: "10px 14px",
            border: 0,
            borderRadius: 8,
            background: t.highlight,
            color: t.highlightFg,
            font: "inherit",
            fontWeight: 650,
            cursor: busy || selected === null ? "not-allowed" : "pointer",
            opacity: selected === null ? 0.65 : 1,
          }}
        >
          {busy ? "Saving…" : interaction.submitLabel ?? "Continue"}
        </button>
      </form>
    </InteractionCard>
  );
}
