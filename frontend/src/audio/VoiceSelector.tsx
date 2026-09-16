import { DEFAULT_VOICE, PIPER_VOICES, QUALITY_LABELS, piperVoice } from "./voice-catalog";
export function VoiceSelector({ voice, onChange, disabled = false }: {
  voice: string; onChange(voice: string): void; disabled?: boolean;
}) {
  const selected = piperVoice(voice);
  const names = [...new Set(PIPER_VOICES.map(entry => entry.name))];
  return <div>
    <label>Speech model <select aria-label="Speech model" disabled={disabled} value={selected ? "piper" : "kokoro"}
      onChange={event => onChange(event.target.value === "piper" ? DEFAULT_VOICE : "af_heart")}>
      <option value="piper">Piper</option><option value="kokoro">Kokoro · Heart</option>
    </select></label>
    {selected && <>
      <label> Voice <select aria-label="Piper voice" disabled={disabled} value={selected.name} onChange={event => {
        const variants = PIPER_VOICES.filter(entry => entry.name === event.target.value);
        onChange((variants.find(entry => entry.quality === selected.quality) ?? variants.find(entry => entry.quality === "medium") ?? variants[0]).id);
      }}>{names.map(name => <option key={name} value={name}>{name.replace(/_/g, " ")}</option>)}</select></label>
      <label> Quality <select aria-label="Piper quality" disabled={disabled} value={selected.quality} onChange={event => {
        const variant = PIPER_VOICES.find(entry => entry.name === selected.name && entry.quality === event.target.value);
        if (variant) onChange(variant.id);
      }}>{Object.entries(QUALITY_LABELS).map(([quality, label]) => {
        const variant = PIPER_VOICES.find(entry => entry.name === selected.name && entry.quality === quality);
        return <option key={quality} value={quality} disabled={!variant}>{label}{variant ? ` · ${(variant.modelBytes / 1e6).toFixed(1)} MB model` : " · unavailable"}</option>;
      })}</select></label>
      <p>US English, single-speaker voices. Extra low is not published for English in this catalog. Quality availability varies by voice.</p>
      <a href={selected.modelCard}>Selected voice model and license</a>
    </>}
  </div>;
}
