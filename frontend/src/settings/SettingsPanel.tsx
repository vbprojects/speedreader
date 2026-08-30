// Reusable settings form for both global and per-reader preferences.

import { useState } from "react";
import type { GlobalSettings, PacingAlgorithm, ReaderSettings, ReaderViewMode, Theme } from "./types";
import { themeTokens } from "./themes";
import { getLatestChangeLog } from "./changelog";
import { NumericSettingControl } from "./NumericSettingControl";
import { PacingPreview } from "./PacingPreview";

export interface SettingsPanelProps {
  settings: GlobalSettings;
  isReader?: boolean;
  onChange: (patch: ReaderSettings) => void;
  onReset?: () => void;
}

const FONTS = ["system-ui", "Georgia, serif", "Arial, sans-serif", "Courier New, monospace", "Verdana, sans-serif"];

export function SettingsPanel({ settings, isReader, onChange, onReset }: SettingsPanelProps) {
  const [showChangelog, setShowChangelog] = useState(false);
  const set = (patch: ReaderSettings) => onChange(patch);
  const t = themeTokens(settings.theme);
  const latestLog = getLatestChangeLog();
  const usesSurprisal = settings.pacingModel.startsWith("surprisal-");
  const memoryWords = Math.round(1 / (1 - (settings.bayesianGamma ?? 0.98)));

  const selectStyle: React.CSSProperties = {
    appearance: "none",
    WebkitAppearance: "none",
    width: "100%",
    minHeight: 44,
    boxSizing: "border-box",
    padding: "9px 36px 9px 12px",
    borderRadius: 12,
    border: `1px solid ${t.border}`,
    backgroundColor: t.panel,
    color: t.fg,
    fontFamily: "inherit",
    fontSize: 16,
    cursor: "pointer",
    outline: "none",
    backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1l5 5 5-5' stroke='${t.muted}' stroke-width='1.5' fill='none' stroke-linecap='round'/></svg>`,
    )}")`,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 14px center",
    boxShadow: "none",
  };
  const optionStyle: React.CSSProperties = { backgroundColor: t.panel, color: t.fg };

  return (
    <div className="settings-panel" style={{ color: t.fg }}>
      <div className="settings-panel-title">
        <div>
          <h3>{isReader ? "Reader settings" : "Global settings"}</h3>
          <p style={{ color: t.muted }}>
            {isReader ? "Changes apply to this book." : "Defaults for every new reader."}
          </p>
        </div>
      </div>

      <SettingsSection title="Appearance" description="Choose how text and the reader surface look." tokens={{ border: t.border, muted: t.muted }}>
        <div className="settings-select-grid">
          <Field label="Theme" color={t.muted}>
            <select style={selectStyle} value={settings.theme} onChange={(event) => set({ theme: event.target.value as Theme })}>
              <option style={optionStyle} value="light">Light</option>
              <option style={optionStyle} value="dark">Dark</option>
              <option style={optionStyle} value="sepia">Sepia</option>
              <option style={optionStyle} value="high-contrast">High contrast</option>
            </select>
          </Field>

          <Field label="Font" color={t.muted}>
            <select style={selectStyle} value={settings.fontFamily} onChange={(event) => set({ fontFamily: event.target.value })}>
              {FONTS.map((font) => (
                <option style={optionStyle} key={font} value={font}>{font.split(",")[0]}</option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Reading view" color={t.muted}>
          <select style={selectStyle} value={settings.viewMode} onChange={(event) => set({ viewMode: event.target.value as ReaderViewMode })}>
            <option style={optionStyle} value="rsvp">RSVP — single word</option>
            <option style={optionStyle} value="context">Context — centered moving text</option>
            <option style={optionStyle} value="read-along">Read along — highlighted text</option>
          </select>
        </Field>

        <NumericSettingControl
          label="Font size"
          description="Use the buttons for precise changes or drag the track for larger adjustments."
          value={settings.fontSize}
          min={16}
          max={64}
          step={1}
          unit="px"
          tokens={t}
          onChange={(fontSize) => set({ fontSize })}
        />
      </SettingsSection>

      <SettingsSection title="Pacing" description="Tune speed and how much word timing is allowed to vary." tokens={{ border: t.border, muted: t.muted }}>
        <Field label="Pacing model" color={t.muted}>
          <select
            style={selectStyle}
            value={settings.pacingModel ?? "naive"}
            onChange={(event) => set({ pacingModel: event.target.value as PacingAlgorithm })}
          >
            <option style={optionStyle} value="naive">Fixed WPM</option>
            <option style={optionStyle} value="bayesian">Bayesian adaptive</option>
            <option style={optionStyle} value="surprisal-normal">N-gram surprisal · Normal</option>
            <option style={optionStyle} value="surprisal-exponential-gamma">N-gram surprisal · Exponential–Gamma</option>
            <option style={optionStyle} value="surprisal-lognormal-nig">N-gram surprisal · Lognormal</option>
          </select>
        </Field>

        <NumericSettingControl
          label="Reading speed"
          description="Your target average. Adaptive models redistribute this time between words."
          value={settings.wpm}
          min={100}
          max={2000}
          step={50}
          unit="WPM"
          tokens={t}
          onChange={(wpm) => set({ wpm })}
        />

        {(settings.pacingModel === "bayesian" || settings.pacingModel === "surprisal-lognormal-nig") && (
          <NumericSettingControl
            label="Model memory"
            description="Higher gamma remembers more previous words; lower values adapt more quickly."
            value={settings.bayesianGamma ?? 0.98}
            min={0.9}
            max={0.999}
            step={0.001}
            decimals={3}
            valueHint={`About ${memoryWords.toLocaleString()} words`}
            tokens={t}
            onChange={(bayesianGamma) => set({ bayesianGamma })}
          />
        )}

        {usesSurprisal && (
          <>
            <NumericSettingControl
              label="Character n-gram size"
              description="The number of adjacent characters scored as one pattern."
              value={settings.surprisalNGramSize ?? 3}
              min={1}
              max={8}
              step={1}
              showRange={false}
              tokens={t}
              onChange={(surprisalNGramSize) => set({ surprisalNGramSize })}
            />

            <NumericSettingControl
              label="Pacing variation"
              description="Even at 0; increasingly expressive toward 1. This widens the millisecond distribution around the WPM baseline."
              value={settings.surprisalSensitivity ?? 0.25}
              min={0}
              max={1}
              step={0.05}
              decimals={2}
              valueHint={(settings.surprisalSensitivity ?? 0.25) < 0.2 ? "Even" : (settings.surprisalSensitivity ?? 0.25) < 0.55 ? "Balanced" : "Expressive"}
              tokens={t}
              onChange={(surprisalSensitivity) => set({ surprisalSensitivity })}
            />
          </>
        )}

        <PacingPreview settings={settings} tokens={t} />
      </SettingsSection>

      <SettingsSection title="Reading pauses" description="Add breathing room at structural boundaries." tokens={{ border: t.border, muted: t.muted }}>
        <NumericSettingControl
          label="Sentence pause"
          value={settings.sentencePauseMs}
          min={0}
          max={500}
          step={25}
          unit="ms"
          tokens={t}
          onChange={(sentencePauseMs) => set({ sentencePauseMs })}
        />
        <NumericSettingControl
          label="Paragraph pause"
          value={settings.paragraphPauseMs}
          min={0}
          max={800}
          step={25}
          unit="ms"
          tokens={t}
          onChange={(paragraphPauseMs) => set({ paragraphPauseMs })}
        />
      </SettingsSection>

      <div className="settings-changelog" style={{ borderColor: `${t.border}88` }}>
        <button
          type="button"
          onClick={() => setShowChangelog((value) => !value)}
          style={{ borderColor: t.border, background: t.panel, color: t.fg }}
        >
          <span>{showChangelog ? "Hide latest changes" : "View latest changes"}</span>
          <span aria-hidden="true" style={{ color: t.muted }}>{showChangelog ? "▲" : "▼"}</span>
        </button>

        {showChangelog && (
          <div className="settings-changelog-body glass-scroll" style={{ borderColor: t.border, background: `${t.bg}cc` }}>
            {latestLog ? (
              <>
                <div style={{ fontWeight: 700, fontSize: 14, color: t.highlight, marginBottom: 4 }}>{latestLog.title}</div>
                {latestLog.date && <div style={{ fontSize: 12, color: t.muted, marginBottom: 8 }}>Released {latestLog.date}</div>}
                <div style={{ whiteSpace: "pre-wrap", color: t.fg, opacity: 0.9 }}>{latestLog.body}</div>
              </>
            ) : (
              <div style={{ color: t.muted }}>No changelog entries found.</div>
            )}
          </div>
        )}
      </div>

      {isReader && onReset && (
        <button
          type="button"
          onClick={onReset}
          className="settings-reset"
          style={{ background: t.panel, color: t.fg, borderColor: t.border }}
        >
          Reset this book to global settings
        </button>
      )}
    </div>
  );
}

function SettingsSection({
  title,
  description,
  children,
  tokens,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  tokens: { border: string; muted: string };
}) {
  return (
    <section className="settings-section" style={{ borderColor: `${tokens.border}88` }}>
      <div className="settings-section-heading">
        <h4>{title}</h4>
        <p style={{ color: tokens.muted }}>{description}</p>
      </div>
      {children}
    </section>
  );
}

function Field({ label, children, color }: { label: string; children: React.ReactNode; color?: string }) {
  return (
    <label className="settings-field">
      <span style={{ color: color ?? "#666" }}>{label}</span>
      {children}
    </label>
  );
}
