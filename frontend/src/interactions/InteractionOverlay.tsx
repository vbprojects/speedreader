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
  if (!interaction) return null;
  return (
    <div
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
        background: "rgba(0, 0, 0, 0.36)",
        backdropFilter: "blur(5px)",
        WebkitBackdropFilter: "blur(5px)",
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
