import "./audio-settings.css";
import { VoiceSelector } from "./VoiceSelector";
import { isPiperVoice } from "./voice-catalog";
import { voiceLabel } from "./voice-pack";
import { useVoiceDownload } from "./use-voice-download";
import { useEffect, useRef, useState } from "react";
import { AudioOutput, resampleAudio } from "./audio-output";
import { NumericSettingControl } from "../settings/NumericSettingControl";
import { themeTokens } from "../settings/themes";
import type { Theme } from "../settings/types";
import type { AudioMeasurements } from "./audio-transport";
import type { AudioSettings } from "./settings";
import type { PackMetadata, PackStore } from "./pack-store";
import type { KokoroEngine } from "./kokoro-engine";
import { estimateWpm } from "./estimate";
import { KOKORO_WPM_PROFILE } from "./profiles";
export function AudioPanel({ settings, onChange, store, metadata, release, backend, backendWarning, selectBackend, state, error, measurements, theme, getEngine, pauseReader, mainRunning, observedWpm }: {
  backendWarning?: string;
  settings: AudioSettings; onChange(patch: Partial<AudioSettings>): void; store: PackStore; metadata: PackMetadata;
  theme: Theme;
  getEngine(): Promise<KokoroEngine>;
  pauseReader(): void;
  mainRunning: boolean;
  observedWpm: number | null;
  measurements?: AudioMeasurements;
  release(): void; backend: "wasm" | "webgpu"; selectBackend(value: "wasm" | "webgpu"): void; state: string; error?: string;
}) {
  const tokens = themeTokens(theme);
  const { installed, busy, message, setMessage, packSize, install, remove, cancel } =
    useVoiceDownload(store, metadata, () => { stopPreview(); onChange({ readAloudEnabled: false }); release(); }, settings.readAloudVoice);
  const previewAbort = useRef<AbortController | null>(null);
  const previewOutput = useRef<AudioOutput | null>(null);
  const [diagnostic, setDiagnostic] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const stopPreview = () => {
    previewAbort.current?.abort(); previewAbort.current = null;
    void previewOutput.current?.dispose(); previewOutput.current = null;
    setPreviewing(false);
  };
  useEffect(() => { if (mainRunning) stopPreview(); }, [mainRunning]);
  useEffect(() => () => { previewAbort.current?.abort(); void previewOutput.current?.dispose(); }, []);
  const preview = async () => {
    pauseReader(); stopPreview();
    const abort = new AbortController(); previewAbort.current = abort;
    setPreviewing(true); setMessage("Preparing voice preview…");
    const output = new AudioOutput(cursor => {
      if (cursor.sample > 0 && cursor.remaining === 0) stopPreview();
    }, error => { stopPreview(); setMessage(error.message); });
    previewOutput.current = output;
    try {
      await output.play();
      const engine = await getEngine();
      const words = "Reading aloud keeps the words and sound together.".split(" ").map((text, index) => ({ text, index, metadata: [] }));
      const result = await engine.prepare(words, { ...settings }, { sessionId: crypto.randomUUID(),
        contentRevision: 0, synthesisRevision: 0, dspRevision: 0 }, words.length, abort.signal);
      const rendered = await resampleAudio(result.pcm, result.sampleRate, output.sampleRate, result.words);
      abort.signal.throwIfAborted(); output.enqueue(rendered.pcm); await output.play(); setMessage("Playing voice preview.");
    } catch (error) {
      if (!abort.signal.aborted) { stopPreview(); setMessage(error instanceof Error ? error.message : String(error)); }
    }
  };
  const testOutput = async () => {
    pauseReader(); stopPreview();
    const abort = new AbortController(); previewAbort.current = abort;
    setPreviewing(true); setDiagnostic("Starting audio test…");
    const output = new AudioOutput(cursor => {
      if (cursor.sample > 0 && cursor.remaining === 0) {
        setDiagnostic("Test tone processed. If you heard nothing, check media volume and audio routing; speech synthesis was bypassed.");
        stopPreview();
      }
    }, error => { setDiagnostic(error.message); stopPreview(); });
    previewOutput.current = output;
    try {
      await output.play();
      if (abort.signal.aborted) return;
      const rate = output.sampleRate;
      const pcm = Float32Array.from({ length: Math.round(rate * 0.6) }, (_, index) => {
        const envelope = Math.min(1, index / (rate * 0.02), (rate * 0.6 - index) / (rate * 0.02));
        return 0.12 * envelope * Math.sin(2 * Math.PI * 440 * index / rate);
      });
      output.enqueue(pcm);
      setDiagnostic(`Test tone queued at ${rate} Hz. Listen for a short beep.`);
    } catch (error) {
      if (!abort.signal.aborted) { setDiagnostic(error instanceof Error ? error.message : String(error)); stopPreview(); }
    }
  };
  const estimate = estimateWpm(settings, { modelRevision: KOKORO_WPM_PROFILE.modelRevision, language: "en" }, KOKORO_WPM_PROFILE);
  return <section className="audio-settings" style={{ "--audio-border": tokens.border, "--audio-panel": tokens.panel, "--audio-fg": tokens.fg, "--audio-muted": tokens.muted } as React.CSSProperties}>
    <div className="audio-settings-heading"><h4>Read aloud</h4><span className="audio-experimental">Experimental</span></div>
    <p className="audio-description">Listen while the reader follows each word. Download a voice for offline playback.</p>
    <VoiceSelector voice={settings.readAloudVoice} disabled={busy} onChange={voice => {
      stopPreview(); pauseReader(); release(); setMessage("Voice changed. Install if needed, then enable Read aloud and press Play.");
      onChange({ readAloudVoice: voice, readAloudEnabled: false });
    }} />
    <p className="audio-description">{voiceLabel(settings.readAloudVoice)} · {packSize} download</p>
    <div className="audio-actions"><button disabled={busy} onClick={() => void install()}>{installed ? "Repair voice" : "Install voice"}</button>{" "}
    {busy && <button onClick={cancel}>Cancel installation</button>}
    <button disabled={busy} onClick={() => void remove()}>{installed ? "Remove voice" : "Discard downloaded files"}</button>
    {settings.readAloudEnabled && mainRunning && <button onClick={pauseReader}>Pause speech</button>}
    {installed && <button disabled={busy} onClick={() => { if (previewing) stopPreview(); else void preview(); }}>{previewing ? "Stop preview" : "Preview voice"}</button>}
    </div>
    <label className="audio-enable"><input type="checkbox" checked={settings.readAloudEnabled}
      disabled={!installed || busy} onChange={event => onChange({ readAloudEnabled: event.target.checked })} /> Enable read aloud</label>
    <label className="audio-enable"><input type="checkbox" checked={settings.readAloudInBackground}
      onChange={event => onChange({ readAloudInBackground: event.target.checked })} /> Continue reading aloud in background</label>
    <p className="audio-description">Keep listening when you switch tabs or apps. Your browser may still suspend audio or speech generation. Closing the reader stops playback.</p>
    <label style={{ display: "block", margin: "8px 0" }}>Speech backend{" "}
      <select aria-label="Speech backend" value={backend} disabled={busy} onChange={event => {
        const value = event.target.value === "webgpu" ? "webgpu" : "wasm";
        stopPreview(); pauseReader(); onChange({ readAloudEnabled: false }); selectBackend(value);
        setMessage(`${value === "webgpu" ? "WebGPU" : "CPU / WASM"} selected. Enable Read aloud, then press Play.`);
      }}>
        <option value="wasm">CPU / WASM</option>
        <option value="webgpu">WebGPU</option>
      </select>
    </label>
    <p className="audio-description">Backend choice is remembered for this browser across books and reloads.</p>
    {backendWarning && <p role="alert">{backendWarning}</p>}
    <NumericSettingControl label={isPiperVoice(settings.readAloudVoice) ? "Piper pacing" : "Kokoro pacing"} value={settings.kokoroPacing} min={0.5} max={4} step={0.05}
      unit="×" tokens={tokens} onChange={kokoroPacing => onChange({ kokoroPacing })} />
    <NumericSettingControl label="Pitch-preserving compression" value={settings.speechCompression} min={0.5} max={4} step={0.05}
      unit="×" tokens={tokens} onChange={speechCompression => onChange({ speechCompression })} />
    {settings.readAloudEnabled && observedWpm !== null && <p className="audio-description">Observed speech · {Math.round(observedWpm)} WPM</p>}
    {settings.readAloudEnabled && <p>Timing follows speech. Speed changes apply after the current phrase.</p>}
    {settings.readAloudEnabled && estimate.status !== "unavailable" && <p>≈ {estimate.roundedWpm} WPM · Python experiment estimate{estimate.extrapolated ? " · outside measured range" : ""}</p>}
    <details className="audio-debug"><summary>Debug and diagnostics</summary>
    <button disabled={previewing || busy} onClick={() => void testOutput()}>Test audio output</button>
    {diagnostic && <p role="status">{diagnostic}</p>}
    <p>{!isPiperVoice(settings.readAloudVoice) && <><a href={`${import.meta.env.BASE_URL}licenses/kokoro-model.txt`}>Model license</a>{" · "}</>}
      <a href={`${import.meta.env.BASE_URL}licenses/headtts.txt`}>Phonemizer license</a>{" · "}
      <a href={`${import.meta.env.BASE_URL}licenses/cmudict.txt`}>Dictionary license</a>{" · "}
      <a href={`${import.meta.env.BASE_URL}licenses/onnxruntime.txt`}>Runtime license</a>{" · "}
      <a href={`${import.meta.env.BASE_URL}licenses/soundtouch.txt`}>DSP license</a></p>
    {measurements && <p>Selected backend: {measurements.provider}. Initialization: {(measurements.initializationMilliseconds / 1000).toFixed(2)} s.
      {" "}Last chunk: {measurements.preparedSeconds.toFixed(1)} s of audio, {measurements.nativeCacheHit ? "reused synthesis" : `${(measurements.synthesisMilliseconds / 1000).toFixed(2)} s to synthesize`}.
      {" "}Prepared ahead: {measurements.bufferedSeconds.toFixed(1)} s.
      {" "}Last wait between audio chunks: {((measurements.lastChunkWaitMilliseconds ?? 0) / 1000).toFixed(2)} s (excludes pauses inside speech).
      {" "}Total preparation: {(measurements.preparationMilliseconds / 1000).toFixed(2)} s
      {" "}(text: {Math.round(measurements.phonemizationMilliseconds)} ms, DSP: {Math.round(measurements.dspMilliseconds)} ms).
      {" "}Production/playback ratio: {(measurements.preparationMilliseconds / 1000 / measurements.preparedSeconds).toFixed(2)}.
      {" "}A ratio above 1 means generation needs more time than playback.</p>}

    {installed && !busy && <>
      <button onClick={() => { stopPreview(); pauseReader(); onChange({ readAloudEnabled: false }); release(); setMessage("Enable Read aloud, then press Play to retry."); }}>Reset voice for retry</button>{" "}
      <button onClick={() => { stopPreview(); pauseReader(); onChange({ readAloudEnabled: false }); selectBackend("wasm"); setMessage("CPU selected. Enable Read aloud, then press Play."); }}>Retry with CPU</button>
    </>}
    </details>
    <p role={error ? "alert" : "status"}>{error || (busy || previewing ? message : settings.readAloudEnabled ? state : message)}</p>
  </section>;
}
