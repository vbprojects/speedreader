import { useEffect, useMemo, useState } from "react";
import type { ThemeTokens } from "./themes";
import type { GlobalSettings } from "./types";
import { buildPacingPreview, buildPreviewOrder } from "./pacing-preview";

interface PacingPreviewProps {
  settings: GlobalSettings;
  tokens: ThemeTokens;
}

const MODEL_LABELS: Record<GlobalSettings["pacingModel"], string> = {
  naive: "Fixed WPM",
  bayesian: "Bayesian adaptive",
  "surprisal-normal": "N-gram · Normal",
  "surprisal-exponential-gamma": "N-gram · Exponential–Gamma",
  "surprisal-lognormal-nig": "N-gram · Lognormal",
};

export function PacingPreview({ settings, tokens }: PacingPreviewProps) {
  const data = useMemo(
    () => buildPacingPreview(settings),
    [
      settings.pacingModel,
      settings.bayesianGamma,
      settings.surprisalNGramSize,
      settings.surprisalSensitivity,
      settings.wpm,
      settings.sentencePauseMs,
      settings.paragraphPauseMs,
    ],
  );
  const order = useMemo(() => buildPreviewOrder(data.points.length), [data.points.length]);
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [phase, setPhase] = useState<"on" | "gap">("on");

  useEffect(() => {
    setCursor(0);
    setPhase("on");
  }, [data]);

  useEffect(() => {
    if (!playing || data.points.length === 0) return;
    const pointIndex = order[cursor % order.length] ?? 0;
    const delay = phase === "on" ? data.points[pointIndex].durationMs : 32;
    const timer = window.setTimeout(() => {
      if (phase === "on") {
        setPhase("gap");
      } else {
        setCursor((value) => (value + 1) % order.length);
        setPhase("on");
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [playing, phase, cursor, data, order]);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const pauseForReducedMotion = () => {
      if (query.matches) setPlaying(false);
    };
    query.addEventListener("change", pauseForReducedMotion);
    pauseForReducedMotion();
    return () => query.removeEventListener("change", pauseForReducedMotion);
  }, []);

  const pointIndex = order[cursor % Math.max(1, order.length)] ?? 0;
  const current = data.points[pointIndex];
  const maxCount = Math.max(1, ...data.bins.map((bin) => bin.count));
  const lit = playing && phase === "on";

  return (
    <section
      className="pacing-preview"
      aria-labelledby="pacing-preview-title"
      style={{ borderColor: tokens.border, background: `${tokens.bg}99` }}
    >
      <div className="pacing-preview-heading">
        <div>
          <h4 id="pacing-preview-title">Timing preview</h4>
          <div style={{ color: tokens.muted }}>{MODEL_LABELS[settings.pacingModel]}</div>
        </div>
        <button
          type="button"
          onClick={() => {
            setPhase("on");
            setPlaying((value) => !value);
          }}
          aria-pressed={playing}
          style={{
            minHeight: 44,
            padding: "0 16px",
            borderRadius: 999,
            border: `1px solid ${playing ? tokens.highlight : tokens.border}`,
            background: playing ? tokens.highlight : tokens.panel,
            color: playing ? tokens.highlightFg : tokens.fg,
            boxShadow: "none",
          }}
        >
          {playing ? "Pause" : "Play timing"}
        </button>
      </div>

      <div className="pacing-pulse-row">
        <div
          className="pacing-pulse"
          aria-label="Timing pulse"
          style={{
            background: lit ? tokens.highlight : tokens.panel,
            borderColor: lit ? tokens.highlight : tokens.border,
            boxShadow: lit ? `0 0 0 6px ${tokens.highlight}22, 0 0 22px ${tokens.highlight}66` : "none",
          }}
        />
        <div className="pacing-pulse-copy">
          <strong>{current?.word ?? "Ready"}</strong>
          <span style={{ color: tokens.muted }}>{current ? `${current.durationMs} ms display` : "No sample"}</span>
        </div>
      </div>

      <div
        className="pacing-histogram"
        role="img"
        aria-label={`Histogram of preview word timings from ${data.minMs} to ${data.maxMs} milliseconds`}
      >
        <div className="pacing-histogram-bars" aria-hidden="true">
          {data.bins.map((bin, index) => (
            <div
              key={`${Math.round(bin.startMs)}-${index}`}
              title={`${Math.round(bin.startMs)}–${Math.round(bin.endMs)} ms: ${bin.count} words`}
              style={{
                height: `${bin.count === 0 ? 0 : Math.max(5, (bin.count / maxCount) * 100)}%`,
                background: tokens.highlight,
                opacity: 0.45 + (bin.count / maxCount) * 0.55,
              }}
            />
          ))}
        </div>
        <div className="pacing-histogram-axis" style={{ color: tokens.muted }}>
          <span>{data.minMs} ms</span>
          <span>{data.maxMs} ms</span>
        </div>
      </div>

      <div className="pacing-preview-stats">
        <Stat label="Median" value={`${data.medianMs} ms`} tokens={tokens} />
        <Stat label="90th percentile" value={`${data.p90Ms} ms`} tokens={tokens} />
        <Stat label="Range" value={`${data.minMs}–${data.maxMs} ms`} tokens={tokens} />
      </div>
      <p style={{ color: tokens.muted }}>
        Representative sample after a short warm-up. Timings include your sentence and paragraph pauses; the live reader keeps its own untouched model state.
      </p>
    </section>
  );
}

function Stat({ label, value, tokens }: { label: string; value: string; tokens: ThemeTokens }) {
  return (
    <div style={{ borderColor: `${tokens.border}aa`, background: tokens.panel }}>
      <span style={{ color: tokens.muted }}>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
