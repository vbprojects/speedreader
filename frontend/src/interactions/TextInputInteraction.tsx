import { useEffect, useId, useState } from "react";
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
  inline = false,
}: {
  interaction: TextInputDescriptor;
  theme?: Theme;
  busy?: boolean;
  error?: string | null;
  onSubmit: (response: TextInputResponse) => Promise<void> | void;
  inline?: boolean;
}) {
  const [value, setValue] = useState(interaction.defaultValue ?? "");
  const [validationError, setValidationError] = useState<string | null>(null);
  const inputId = useId();
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
    <InteractionCard interaction={interaction} theme={theme} busy={busy} error={error ?? validationError} inline={inline}>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void submit();
        }}
      >
        <label
          htmlFor={inputId}
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
          {interaction.label}
        </label>
        <input
          id={inputId}
          name={interaction.id}
          autoFocus={!inline}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (validationError) setValidationError(null);
          }}
          placeholder={interaction.placeholder}
          disabled={busy}
          required={constraints?.required}
          minLength={constraints?.minLength}
          maxLength={constraints?.maxLength}
          aria-invalid={Boolean(error ?? validationError) || undefined}
          style={{
            width: "100%",
            boxSizing: "border-box",
            minHeight: 44,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid " + t.border,
            background: t.bg,
            color: t.fg,
            font: "inherit",
            textAlign: "left",
            outlineColor: t.highlight,
          }}
        />
        <button
          type="submit"
          disabled={busy}
          style={{
            marginTop: 14,
            width: "100%",
            minHeight: 44,
            padding: "10px 14px",
            border: 0,
            borderRadius: 8,
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
