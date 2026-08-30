import { useEffect, useId, useState } from "react";
import type { ThemeTokens } from "./themes";

interface NumericSettingControlProps {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  decimals?: number;
  showRange?: boolean;
  valueHint?: string;
  tokens: ThemeTokens;
  onChange: (value: number) => void;
}

function decimalsFor(step: number): number {
  const text = String(step);
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
}

export function clampSettingValue(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  const decimals = decimalsFor(step);
  const stepped = min + Math.round((clamped - min) / step) * step;
  return Number(Math.min(max, Math.max(min, stepped)).toFixed(decimals));
}

export function NumericSettingControl({
  label,
  description,
  value,
  min,
  max,
  step,
  unit,
  decimals = decimalsFor(step),
  showRange = true,
  valueHint,
  tokens,
  onChange,
}: NumericSettingControlProps) {
  const id = useId();
  const [draft, setDraft] = useState(value.toFixed(decimals));

  useEffect(() => setDraft(value.toFixed(decimals)), [value, decimals]);

  const commitDraft = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(value.toFixed(decimals));
      return;
    }
    const next = clampSettingValue(parsed, min, max, step);
    setDraft(next.toFixed(decimals));
    if (next !== value) onChange(next);
  };

  const adjust = (direction: -1 | 1) => {
    const next = clampSettingValue(value + direction * step, min, max, step);
    if (next !== value) onChange(next);
  };

  const buttonStyle: React.CSSProperties = {
    width: 44,
    height: 44,
    flex: "0 0 44px",
    display: "grid",
    placeItems: "center",
    padding: 0,
    border: `1px solid ${tokens.border}`,
    borderRadius: 12,
    background: tokens.panel,
    color: tokens.fg,
    boxShadow: "none",
    fontSize: 22,
    lineHeight: 1,
  };

  return (
    <div className="settings-control" style={{ borderColor: `${tokens.border}aa`, background: `${tokens.bg}66` }}>
      <div className="settings-control-heading">
        <div>
          <label htmlFor={`${id}-number`} className="settings-control-label">{label}</label>
          {valueHint && <div className="settings-control-hint" style={{ color: tokens.highlight }}>{valueHint}</div>}
        </div>
        <div className="settings-value-input" style={{ borderColor: tokens.border, background: tokens.panel }}>
          <input
            id={`${id}-number`}
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={step}
            value={draft}
            aria-label={`${label} value`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setDraft(value.toFixed(decimals));
                event.currentTarget.blur();
              }
            }}
            style={{ color: tokens.fg }}
          />
          {unit && <span style={{ color: tokens.muted }}>{unit}</span>}
        </div>
      </div>

      <div className="settings-control-adjuster">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          disabled={value <= min}
          onClick={() => adjust(-1)}
          style={buttonStyle}
        >
          −
        </button>
        {showRange ? (
          <div className="settings-range-zone">
            <input
              type="range"
              aria-label={label}
              min={min}
              max={max}
              step={step}
              value={value}
              onChange={(event) => onChange(Number(event.target.value))}
              style={{ accentColor: tokens.highlight }}
            />
          </div>
        ) : (
          <div className="settings-stepper-track" aria-hidden="true" style={{ color: tokens.muted }}>
            {min}–{max}
          </div>
        )}
        <button
          type="button"
          aria-label={`Increase ${label}`}
          disabled={value >= max}
          onClick={() => adjust(1)}
          style={buttonStyle}
        >
          +
        </button>
      </div>

      {description && <div className="settings-control-description" style={{ color: tokens.muted }}>{description}</div>}
    </div>
  );
}
