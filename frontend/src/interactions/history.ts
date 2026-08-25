import type { InteractionRecord, ReaderInteraction } from "./types";

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : trimmed + ".";
}

/** Render an answered interaction as safe, plain text in the reading flow. */
export function formatResolvedInteraction(
  interaction: ReaderInteraction,
  record: InteractionRecord,
): string {
  switch (interaction.kind) {
    case "continue":
      return sentence(interaction.history?.text ?? "You continued.");
    case "text-input": {
      const value = record.response.kind === "text-input" ? record.response.value : "";
      const presentation = interaction.history;
      const renderedValue = presentation?.quoteValue === false ? value : `“${value}”`;
      return sentence(`${presentation?.prefix ?? "You answered"} ${renderedValue}${presentation?.suffix ?? ""}`);
    }
    case "single-choice": {
      const optionId = record.response.kind === "single-choice" ? record.response.optionId : "";
      const option = interaction.options.find((candidate) => candidate.id === optionId);
      return sentence(option?.resolvedText ?? `You chose ${option?.label ?? "an option"}`);
    }
  }
}
