import { useEffect, useState } from "react";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";
import type { TextInputInteraction as TextInputDescriptor, TextInputResponse } from "./types";
import { InteractionCard } from "./InteractionCard";

export function TextInputInteraction({
  interaction,
  theme = "light",
  busy = false,
  error,
  onSubmit,
}: {
  interaction: TextInputDescriptor;
  theme?: Theme;
  busy?: boolean;
  error?: string | null;
  onSubmit: (response: TextInputResponse) => Promise<void> | void;
}) {
  const [value, setValue] = useState(interaction.defaultValue ?? "");
  const [validationError, setValidationError] = useState<string | null>(null);
  useEffect(() => {
    setValue(interaction.defaultValue ?? "");
    setValidationError(null);
  }, [interaction.id, interaction.defaultValue]);

  const t = themeTokens(theme);
  const constraints = interaction.constraints;
  const submit = async () => {
    const trimmed = value.trim();
    if (constraints?.required && trimmed.length === 0) {
      setValidationError("This field is required.");
      return;
    }
    if (constraints?.minLength !== undefined && value.length < constraints.minLength) {
      setValidationError("Use at least " + constraints.minLength + " characters.");
      return;
    }
    if (constraints?.maxLength !== undefined && value.length > constraints.maxLength) {
      setValidationError("Use no more than " + constraints.maxLength + " characters.");
      return;
    }
    setValidationError(null);
    await onSubmit({
      schemaVersion: 1,
      interactionId: interaction.id,
      kind: "text-input",
      value,
    });
  };

  return (
    <InteractionCard interaction={interaction} theme={theme} busy={busy} error={error ?? validationError}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void submit();
        }}
      >
        <input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={interaction.placeholder}
          disabled={busy}
          aria-label={interaction.label}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "12px 14px",
            borderRadius: 12,
            border: "1px solid " + t.border,
            background: t.bg + "cc",
            color: t.fg,
            font: "inherit",
            outlineColor: t.highlight,
          }}
        />
        <button
          type="submit"
          disabled={busy}
          style={{
            marginTop: 14,
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
          {busy ? "Saving…" : interaction.submitLabel ?? "Continue"}
        </button>
      </form>
    </InteractionCard>
  );
}
