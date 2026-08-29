import { useEffect, useRef } from "react";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";
import { ChoiceInteraction } from "./ChoiceInteraction";
import { ContinueInteraction } from "./ContinueInteraction";
import { formatResolvedInteraction } from "./history";
import { TextInputInteraction } from "./TextInputInteraction";
import type { InteractionRecord, InteractionResponse, ReaderInteraction } from "./types";

export function InlineInteraction({
  interaction,
  record,
  theme = "light",
  busy = false,
  error,
  editing = false,
  active = false,
  onSubmit,
  onEdit,
  onCancelEdit,
}: {
  interaction: ReaderInteraction;
  record?: InteractionRecord;
  theme?: Theme;
  busy?: boolean;
  error?: string | null;
  editing?: boolean;
  /** Move keyboard focus into this inline action when it becomes blocking. */
  active?: boolean;
  onSubmit: (response: InteractionResponse) => Promise<void> | void;
  onEdit?: () => void;
  onCancelEdit?: () => void;
}) {
  const t = themeTokens(theme);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    containerRef.current
      ?.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled])")
      ?.focus();
  }, [active, interaction.id]);

  if (record && !editing) {
    const mutable = interaction.editPolicy === "mutable";
    return (
      <div
        data-interaction-id={interaction.id}
        style={{ margin: "22px 0", padding: "14px 16px", borderLeft: `3px solid ${t.highlight}`, color: t.fg, background: t.panel, borderRadius: 8 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ flex: 1, lineHeight: 1.5 }}>{formatResolvedInteraction(interaction, record)}</span>
          {mutable ? (
            <button type="button" onClick={(event) => { event.stopPropagation(); onEdit?.(); }} disabled={!onEdit} style={{ minHeight: 36, border: `1px solid ${t.border}`, background: t.bg, color: t.fg, borderRadius: 8, padding: "6px 10px", cursor: onEdit ? "pointer" : "default" }}>
              Edit
            </button>
          ) : <span title="This action cannot be edited" aria-label="Action is locked" style={{ color: t.muted, fontSize: 13 }}>Locked</span>}
        </div>
      </div>
    );
  }

  const resolvedInput = interaction.kind === "text-input"
    ? { ...interaction, defaultValue: record?.response.kind === "text-input" ? record.response.value : interaction.defaultValue }
    : undefined;
  const submit = async (response: InteractionResponse) => onSubmit(response);
  const cancel = onCancelEdit ? (
    <button type="button" onClick={onCancelEdit} disabled={busy} style={{ minHeight: 36, marginTop: 10, padding: "6px 10px", border: `1px solid ${t.border}`, borderRadius: 8, background: t.bg, color: t.fg, cursor: busy ? "wait" : "pointer" }}>Cancel edit</button>
  ) : null;
  return (
    <div ref={containerRef} style={{ margin: "22px 0" }} onClick={(event) => event.stopPropagation()}>
      {resolvedInput && <TextInputInteraction interaction={resolvedInput} theme={theme} busy={busy} error={error} inline onSubmit={submit} />}
      {interaction.kind === "single-choice" && <ChoiceInteraction interaction={interaction} theme={theme} busy={busy} error={error} inline onSubmit={submit} />}
      {interaction.kind === "continue" && <ContinueInteraction interaction={interaction} theme={theme} busy={busy} error={error} inline onSubmit={submit} />}
      {editing && cancel}
    </div>
  );
}
