import vocabulary from "./vendor/kokoro-vocabulary.json";
import type { PhonemizedPhrase } from "./phonemizer";
export interface PiperConfig {
  audio: { sample_rate: number };
  phoneme_id_map: Record<string, number[]>;
  inference: { noise_scale: number; length_scale: number; noise_w: number };
}
const symbols = new Map(Object.entries(vocabulary).map(([symbol, id]) => [id, symbol]));
// Reverse the English HeadTTS compact diphthong/affricate notation to IPA.
// This is a provenance-preserving experimental alternative to eSpeak; it does
// not claim the same pronunciation or prosody as Piper's reference phonemizer.
const ipa: Record<string, string> = { A: "eɪ", I: "aɪ", O: "oʊ", Q: "əʊ", W: "aʊ", Y: "ɔɪ", "ʧ": "tʃ", "ʤ": "dʒ" };
export function piperInput(phrase: PhonemizedPhrase, config: PiperConfig): PhonemizedPhrase {
  const token = (symbol: string): number[] => {
    const value = config.phoneme_id_map[symbol];
    if (!value?.length) throw new Error(`Piper cannot speak phoneme: ${symbol}`);
    return value;
  };
  const ids = [...token("^"), ...token("_")];
  const offsets = [0, ids.length];
  let phonemes = "";
  for (let i = 1; i < phrase.ids.length - 1; i++) {
    const symbol = symbols.get(phrase.ids[i]);
    if (!symbol) throw new Error("Unknown English phoneme ID");
    const expanded = ipa[symbol] ?? symbol;
    for (const ph of expanded) {
      // Unsupported speech symbols and punctuation have no duration. Keep the
      // source offset; required control tokens still use strict validation.
      if (!config.phoneme_id_map[ph]?.length) continue;
      ids.push(...token(ph), ...token("_"));
      phonemes += ph;
    }
    offsets.push(ids.length);
  }
  ids.push(...token("$"));
  return { ...phrase, ids, phonemes, words: phrase.words.map(word => ({ ...word,
    tokenStart: offsets[word.tokenStart], tokenEnd: offsets[word.tokenEnd] })) };
}
