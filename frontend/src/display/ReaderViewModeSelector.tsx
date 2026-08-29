import type { ReaderViewMode, Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";

export function ReaderViewModeSelector({
  value,
  onChange,
  theme = "light",
}: {
  value: ReaderViewMode;
  onChange: (mode: ReaderViewMode) => void;
  theme?: Theme;
}) {
  const t = themeTokens(theme);
  const option = (mode: ReaderViewMode, label: string) => {
    const selected = value === mode;
    return (
      <button
        key={mode}
        type="button"
        aria-pressed={selected}
        onClick={(event) => {
          event.stopPropagation();
          onChange(mode);
        }}
        style={{
          minHeight: 34,
          padding: "6px 12px",
          border: 0,
          borderRadius: 7,
          background: selected ? t.active : "transparent",
          color: selected ? t.activeFg : t.fg,
          font: "inherit",
          fontSize: 13,
          fontWeight: selected ? 650 : 500,
          cursor: "pointer",
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      role="group"
      aria-label="Reading view"
      style={{
        display: "inline-flex",
        gap: 2,
        padding: 3,
        border: `1px solid ${t.border}`,
        borderRadius: 10,
        background: t.panel,
      }}
    >
      {option("rsvp", "RSVP")}
      {option("context", "Context")}
      {option("read-along", "Read along")}
    </div>
  );
}
