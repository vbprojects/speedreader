// src/settings/SettingsPanel.tsx
// Reusable settings form. Used for both global (library) settings and
// per-reader (local) settings. Calls onChange with partial updates.

import { useState } from "react";
import type { GlobalSettings, PacingAlgorithm, ReaderSettings, ReaderViewMode, Theme } from "./types";
import { themeTokens } from "./themes";
import { getLatestChangeLog } from "./changelog";

export interface SettingsPanelProps {
  /** Current effective settings to display. */
  settings: GlobalSettings;
  /** Whether this is the per-reader panel (shows a "reset to global" option). */
  isReader?: boolean;
  /** Called with partial updates. */
  onChange: (patch: ReaderSettings) => void;
  /** Called to reset per-reader overrides. */
  onReset?: () => void;
}

const FONTS = ["system-ui", "Georgia, serif", "Arial, sans-serif", "Courier New, monospace", "Verdana, sans-serif"];

export function SettingsPanel({ settings, isReader, onChange, onReset }: SettingsPanelProps) {
  const [showChangelog, setShowChangelog] = useState(false);
  const set = (patch: ReaderSettings) => onChange(patch);
  const t = themeTokens(settings.theme);
  const latestLog = getLatestChangeLog();

  // Blended native controls: soft, theme-aware, no stark white boxes.
  const selectStyle: React.CSSProperties = {
    appearance: "none",
    WebkitAppearance: "none",
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 28px 8px 12px",
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    backgroundColor: t.panel,
    color: t.fg,
    fontFamily: "inherit",
    fontSize: 14,
    cursor: "pointer",
    outline: "none",
    backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1l5 5 5-5' stroke='${t.muted}' stroke-width='1.5' fill='none' stroke-linecap='round'/></svg>`
    )}")`,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 12px center",
  };

  // Custom chevron; browser renders the popup list from these backgrounds too.
  const optionStyle: React.CSSProperties = { backgroundColor: t.panel, color: t.fg };
  // Soft native accent for sliders + checkbox.
  const controlAccent: React.CSSProperties = { accentColor: t.highlight };

  return (
    <div style={{ fontFamily: "system-ui", padding: 16, minWidth: 0, width: "100%", boxSizing: "border-box", color: t.fg }}>
      <h3 style={{ marginTop: 0 }}>{isReader ? "Reader Settings" : "Global Settings"}</h3>

      <Field label="Theme">
        <select style={selectStyle} value={settings.theme} onChange={(e) => set({ theme: e.target.value as Theme })}>
          <option style={optionStyle} value="light">Light</option>
          <option style={optionStyle} value="dark">Dark</option>
          <option style={optionStyle} value="sepia">Sepia</option>
          <option style={optionStyle} value="high-contrast">High Contrast</option>
        </select>
      </Field>

      <Field label="Font" color={t.muted}>
        <select style={selectStyle} value={settings.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })}>
          {FONTS.map((f) => (
            <option style={optionStyle} key={f} value={f}>{f.split(",")[0]}</option>
          ))}
        </select>
      </Field>

      <Field label="Reading view" color={t.muted}>
        <select style={selectStyle} value={settings.viewMode} onChange={(e) => set({ viewMode: e.target.value as ReaderViewMode })}>
          <option style={optionStyle} value="rsvp">RSVP — single word</option>
          <option style={optionStyle} value="read-along">Read along — highlighted text</option>
        </select>
      </Field>

      <Field label="Pacing Model" color={t.muted}>
        <select
          style={selectStyle}
          value={settings.pacingModel ?? "naive"}
          onChange={(e) => set({ pacingModel: e.target.value as PacingAlgorithm })}
        >
          <option style={optionStyle} value="naive">Naive (Fixed WPM)</option>
          <option style={optionStyle} value="bayesian">Bayesian Adaptive (Poisson–Gamma)</option>
          <option style={optionStyle} value="surprisal-normal">N-Gram Surprisal (Normal)</option>
          <option style={optionStyle} value="surprisal-exponential-gamma">N-Gram Surprisal (Exponential–Gamma)</option>
          <option style={optionStyle} value="surprisal-lognormal-nig">N-Gram Surprisal (Length-Conditioned Lognormal)</option>
        </select>
      </Field>

      {(settings.pacingModel === "bayesian" || settings.pacingModel === "surprisal-lognormal-nig") && (
        <Field
          label={`Memory factor: ${(settings.bayesianGamma ?? 0.98).toFixed(3)} (~${Math.round(1 / (1 - (settings.bayesianGamma ?? 0.98)))} words)`}
          color={t.muted}
        >
          <input
            type="range"
            min={0.90}
            max={0.999}
            step={0.005}
            style={controlAccent}
            value={settings.bayesianGamma ?? 0.98}
            onChange={(e) => set({ bayesianGamma: Number(e.target.value) })}
          />
        </Field>
      )}

      <Field label={`Font size: ${settings.fontSize}px`} color={t.muted}>
        <input
          type="range"
          min={16}
          max={64}
          style={controlAccent}
          value={settings.fontSize}
          onChange={(e) => set({ fontSize: Number(e.target.value) })}
        />
      </Field>

      <Field label={`WPM: ${settings.wpm}`} color={t.muted}>
        <input
          type="range"
          min={100}
          max={2000}
          step={50}
          style={controlAccent}
          value={settings.wpm}
          onChange={(e) => set({ wpm: Number(e.target.value) })}
        />
      </Field>

      <Field label={`Sentence pause: ${settings.sentencePauseMs}ms`} color={t.muted}>
        <input
          type="range"
          min={0}
          max={500}
          step={25}
          style={controlAccent}
          value={settings.sentencePauseMs}
          onChange={(e) => set({ sentencePauseMs: Number(e.target.value) })}
        />
      </Field>

      <Field label={`Paragraph pause: ${settings.paragraphPauseMs}ms`} color={t.muted}>
        <input
          type="range"
          min={0}
          max={800}
          step={25}
          style={controlAccent}
          value={settings.paragraphPauseMs}
          onChange={(e) => set({ paragraphPauseMs: Number(e.target.value) })}
        />
      </Field>

      {/* Changelog display */}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${t.border}88` }}>
        <button
          type="button"
          onClick={() => setShowChangelog((v) => !v)}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 12px",
            borderRadius: 8,
            border: `1px solid ${t.border}`,
            background: `${t.panel}ee`,
            color: t.fg,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <span>📜 {showChangelog ? "Hide Changelog" : "View Latest Changelog"}</span>
          <span style={{ fontSize: 11, color: t.muted }}>{showChangelog ? "▲" : "▼"}</span>
        </button>

        {showChangelog && (
          <div
            className="glass-scroll"
            style={{
              marginTop: 10,
              padding: "12px 14px",
              borderRadius: 10,
              border: `1px solid ${t.border}`,
              background: `${t.bg}cc`,
              maxHeight: 200,
              overflowY: "auto",
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            {latestLog ? (
              <>
                <div style={{ fontWeight: 700, fontSize: 13, color: t.highlight, marginBottom: 4 }}>
                  {latestLog.title}
                </div>
                {latestLog.date && (
                  <div style={{ fontSize: 11, color: t.muted, marginBottom: 8 }}>
                    Release Date: {latestLog.date}
                  </div>
                )}
                <div style={{ whiteSpace: "pre-wrap", color: t.fg, opacity: 0.9 }}>
                  {latestLog.body}
                </div>
              </>
            ) : (
              <div style={{ color: t.muted }}>No changelog entries found.</div>
            )}
          </div>
        )}
      </div>

      {isReader && onReset && (
        <button onClick={onReset} style={{ marginTop: 12, background: t.panel, color: t.fg, border: `1px solid ${t.border}`, borderRadius: 4, padding: "4px 10px", cursor: "pointer" }}>
          Reset to global
        </button>
      )}
    </div>
  );
}

function Field({ label, children, color }: { label: string; children: React.ReactNode; color?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: color ?? "#666", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
